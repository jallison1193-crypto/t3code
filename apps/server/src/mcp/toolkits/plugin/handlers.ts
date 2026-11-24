import {
  OrchestratorMcpFailure,
  PLUGIN_PANEL_HTML_MAX_CHARS,
  PLUGIN_PANEL_TITLE_MAX_LENGTH,
  type PluginOperationError,
} from "@t3tools/contracts";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import * as Effect from "effect/Effect";

import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PluginToolkit } from "./tools.ts";

const PLUGIN_GUIDE = [
  "Plugins add custom CSS (layered after the active theme) and/or right panel tabs on web and desktop. A new plugin starts off until the user installs it from the card in the chat; edits to an existing plugin save immediately (and apply live if it is already enabled) with Undo on the card.",
  "",
  'Panels: pass `panels: [{ id, title, html }]` (1 to 4 self-contained HTML pages, up to 200,000 characters each). Each panel runs sandboxed with no network access and should style itself with the theme CSS variables delivered in `hostContext.styles.variables` (such as `--color-background-primary`, `--color-text-primary`, and `--color-border-primary`). Communicate with T3 using JSON-RPC 2.0 over `window.parent.postMessage`: send `ui/initialize`, wait for its result, then send `ui/notifications/initialized`. Read and save JSON (up to 64 KB) with `tools/call` `t3_plugin_state_get` and `t3_plugin_state_set` (`scope`: `"global"` or `"project"`), and listen for live `t3/notifications/state-changed` notifications (`{ scope, value }`). Keep time-based state as timestamps rather than counters so it survives reloads and tab switches.',
  "",
  "```html",
  "<script>",
  "let nextId = 1, state = null;",
  "const rpc = (method, params) => parent.postMessage({ jsonrpc: '2.0', id: nextId++, method, params }, '*');",
  "const save = (value) => rpc('tools/call', { name: 't3_plugin_state_set', arguments: { scope: 'global', value } });",
  "const applyTheme = (vars) => Object.entries(vars ?? {}).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));",
  "addEventListener('message', ({ source, data }) => {",
  "  if (source !== parent || data?.jsonrpc !== '2.0') return;",
  "  if (data.id === 1 && data.result) {",
  "    applyTheme(data.result.hostContext?.styles?.variables);",
  "    parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');",
  "  } else if (data.method === 'ui/notifications/host-context-changed') {",
  "    applyTheme(data.params?.styles?.variables);",
  "  } else if (data.method === 't3/notifications/state-changed' && data.params?.scope === 'global') {",
  "    state = data.params.value; render();",
  "  }",
  "});",
  "rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'panel', version: '1.0.0' } });",
  "</script>",
  "```",
  "",
  THEME_GUIDE,
].join("\n");

const mapPluginError = (error: PluginOperationError): OrchestratorMcpFailure => {
  switch (error.reason) {
    case "invalid_id":
    case "invalid_css":
    case "invalid_panel":
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
        plugins: plugins.map(
          ({ id, displayName, enabled, contributes, panels, revision, problem }) => ({
            id,
            ...(displayName === undefined ? {} : { displayName }),
            enabled,
            contributes,
            ...(panels === undefined ? {} : { panels }),
            ...(revision === undefined ? {} : { revision }),
            ...(problem === undefined ? {} : { problem }),
          }),
        ),
        ...(plugin === undefined ? {} : { plugin }),
        guide: PLUGIN_GUIDE,
      };
    }),
  ),
  t3_plugin_write: McpToolAccess.writesEnvironment(
    ({ pluginId, displayName, description, version, css, panels }, check) =>
      Effect.gen(function* () {
        if (css === undefined && (panels === undefined || panels.length === 0)) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Provide css, panels, or both.",
          });
        }
        if (panels !== undefined) {
          for (const panel of panels) {
            const title = panel.title.trim();
            if (title.length === 0 || title.length > PLUGIN_PANEL_TITLE_MAX_LENGTH) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Panel "${panel.id}" title must be 1 to ${PLUGIN_PANEL_TITLE_MAX_LENGTH} characters.`,
              });
            }
            if (panel.html.length > PLUGIN_PANEL_HTML_MAX_CHARS) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Panel "${panel.id}" HTML exceeds the ${PLUGIN_PANEL_HTML_MAX_CHARS} character limit.`,
              });
            }
          }
        }
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
              ...(css === undefined ? {} : { css }),
              ...(panels === undefined ? {} : { panels }),
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
