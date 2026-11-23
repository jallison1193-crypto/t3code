import { OrchestratorMcpFailure, type PluginOperationError } from "@t3tools/contracts";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import * as Effect from "effect/Effect";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PluginToolkit } from "./tools.ts";

const PLUGIN_GUIDE = [
  "Plugins add custom CSS on web and desktop, layered after the active theme. A new plugin starts off until the user installs it from the card in the chat; edits to an existing plugin save immediately (and apply live if it is already enabled) with Undo on the card.",
  "",
  THEME_GUIDE,
].join("\n");

const mapPluginError = (error: PluginOperationError): OrchestratorMcpFailure => {
  switch (error.reason) {
    case "invalid_id":
    case "invalid_css":
    case "has_problem":
    case "not_found":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    default:
      return unavailable();
  }
};

export const layer = McpToolAccess.toLayer(PluginToolkit, {
  t3_plugin_read: McpToolAccess.reads(({ pluginId }) =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry.PluginRegistry;
      const { pluginsDir, plugins } = yield* registry.list.pipe(Effect.mapError(mapPluginError));
      const plugin =
        pluginId === undefined
          ? undefined
          : yield* registry.read(pluginId).pipe(Effect.mapError(mapPluginError));
      return {
        pluginsDir,
        plugins: plugins.map(({ id, displayName, enabled, contributes, revision, problem }) => ({
          id,
          ...(displayName === undefined ? {} : { displayName }),
          enabled,
          contributes,
          ...(revision === undefined ? {} : { revision }),
          ...(problem === undefined ? {} : { problem }),
        })),
        ...(plugin === undefined ? {} : { plugin }),
        guide: PLUGIN_GUIDE,
      };
    }),
  ),
  t3_plugin_write: McpToolAccess.writesEnvironment(
    ({ pluginId, displayName, description, version, css }, check) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const registry = yield* PluginRegistry.PluginRegistry;
        const write = Effect.gen(function* () {
          // The turn may have ended, or the thread's modes changed, while this waited for the lock.
          yield* check;
          const result = yield* registry
            .write({
              id: pluginId,
              ...(displayName === undefined ? {} : { displayName }),
              ...(description === undefined ? {} : { description }),
              ...(version === undefined ? {} : { version }),
              css,
            })
            .pipe(Effect.mapError(mapPluginError));
          const applied = result.plugin.enabled && result.plugin.problem === undefined;
          const next = result.created
            ? applied
              ? "Live now; the user can manage it from the card in the chat."
              : "The user turns it on with Install on the card in the chat."
            : applied
              ? "Live now; the user can Undo from the card."
              : "Saved; it is off, so turn it on in Settings > Plugins.";
          return {
            pluginId,
            created: result.created,
            enabled: result.plugin.enabled,
            applied,
            contributes: result.plugin.contributes,
            ...(result.before === undefined ? {} : { before: result.before }),
            after: result.after,
            next,
          };
        });
        return yield* scope.thread === undefined
          ? write
          : executor.withLock(scope.thread.threadId, write);
      }),
  ),
});
