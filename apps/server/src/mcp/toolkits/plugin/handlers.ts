import {
  OrchestratorMcpFailure,
  PLUGIN_INSTRUCTIONS_MAX_BYTES,
  PLUGIN_MAX_SKILLS,
  PLUGIN_PANEL_HTML_MAX_CHARS,
  PLUGIN_PANEL_TITLE_MAX_LENGTH,
  PLUGIN_SKILL_MAX_BYTES,
  PLUGIN_WORKER_CODE_MAX_CHARS,
  PLUGIN_WORKER_MAX_FOLDERS,
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
  "Plugins add custom CSS (layered after the active theme), right panel tabs on web and desktop, background server workers, slash commands, agent skills, and agent instructions (AGENTS.md). A new plugin starts off until the user installs it from the card in the chat; edits to an existing plugin save immediately (and apply live if it is already enabled) with Undo on the card. Omitted parts stay unchanged on edit.",
  "",
  "Skills and slash commands: pass `skills: [{ name, description, argumentHint?, userInvocable?, modelInvocable?, body }]` (up to 32 entries, 32 KB each), written as `skills/<name>/SKILL.md` in Claude Code format and delivered by T3 to every provider. To make a slash command like `/standup`, pass `userInvocable: true` (default) and `modelInvocable: false` (writes `disable-model-invocation: true`, so only the user triggers it). Leave `modelInvocable: true` (default) for skills the model can discover and read on demand; set `userInvocable: false` to hide an entry from the `/` menu. Command bodies support `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` (0-based), `${CLAUDE_PLUGIN_ROOT}`, `${T3_PLUGIN_ROOT}`, and `${CLAUDE_SKILL_DIR}`. If the body omits `$ARGUMENTS` and the user passes arguments, T3 appends `ARGUMENTS: <args>`.",
  "",
  'Instructions: pass `instructions` (up to 8 KB, written to `AGENTS.md` at the plugin root; pass an empty string `""` to remove it). Use `instructions` for short rules that should apply on every turn across all providers; use skills for longer, on-demand procedures.',
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
  'Workers: pass `worker: { code, everyMinutes?, folders?, network? }` (`code` is ESM up to 200,000 characters; `everyMinutes` 5-1440; `folders` 0-4 items `{ id, label, access: "read" | "write" }`; `network` defaults to false). The agent cannot choose folder paths; the user picks server-machine paths in Settings > Plugins. The worker starts after Install (or Approve when powers change) and once all declared folders are set. Your default export receives `t3` with `t3.folders`, `t3.log(...args)` (and `console.*`), `t3.onRun(async ({ reason }) => ...)` (`"start" | "schedule" | "manual"`), `t3.state.get()/set(value)` (global 64 KB JSON), `t3.projects.list()` (`[{ id, title }]`), and `t3.projects.readMemory(projectId)` (`{ memory, files: [{ name, text }] }`, where `files` are the project knowledge files).',
  "",
  "Example (reads project memory, writes into the granted `out` folder, saves state, and logs):",
  "",
  "```js",
  'import { writeFile } from "node:fs/promises";',
  'import { join } from "node:path";',
  "export default (t3) => t3.onRun(async ({ reason }) => {",
  "  const prev = await t3.state.get();",
  "  const projects = await t3.projects.list();",
  "  const first = projects[0] ? await t3.projects.readMemory(projects[0].id) : null;",
  '  if (first?.memory) await writeFile(join(t3.folders.out, "MEMORY.md"), first.memory);',
  "  await t3.state.set({ reason, count: projects.length, prev });",
  '  t3.log("Synced", projects.length, "projects");',
  "});",
  "```",
  "",
  THEME_GUIDE,
].join("\n");

const mapPluginError = (error: PluginOperationError): OrchestratorMcpFailure => {
  switch (error.reason) {
    case "invalid_id":
    case "invalid_css":
    case "invalid_panel":
    case "invalid_worker":
    case "invalid_skill":
    case "invalid_instructions":
    case "invalid_folder":
    case "repo_plugin_readonly":
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
          ({
            id,
            displayName,
            enabled,
            contributes,
            panels,
            worker,
            commands,
            skills,
            unsupported,
            revision,
            problem,
          }) => ({
            id,
            ...(displayName === undefined ? {} : { displayName }),
            enabled,
            contributes,
            ...(panels === undefined ? {} : { panels }),
            ...(worker === undefined ? {} : { worker }),
            ...(commands === undefined ? {} : { commands }),
            ...(skills === undefined ? {} : { skills }),
            ...(unsupported === undefined ? {} : { unsupported }),
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
    (
      { pluginId, displayName, description, version, css, panels, worker, skills, instructions },
      check,
    ) =>
      Effect.gen(function* () {
        if (
          css === undefined &&
          (panels === undefined || panels.length === 0) &&
          worker === undefined &&
          skills === undefined &&
          instructions === undefined
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Provide css, panels, worker, skills, instructions, or any combination.",
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
        if (worker !== undefined) {
          if (worker.code.length > PLUGIN_WORKER_CODE_MAX_CHARS) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Worker code exceeds the ${PLUGIN_WORKER_CODE_MAX_CHARS} character limit.`,
            });
          }
          if (worker.folders !== undefined && worker.folders.length > PLUGIN_WORKER_MAX_FOLDERS) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Worker can declare at most ${PLUGIN_WORKER_MAX_FOLDERS} folders.`,
            });
          }
        }
        if (skills !== undefined) {
          if (skills.length > PLUGIN_MAX_SKILLS) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Plugin can define at most ${PLUGIN_MAX_SKILLS} skills and commands.`,
            });
          }
          for (const skill of skills) {
            if (Buffer.byteLength(skill.body, "utf8") > PLUGIN_SKILL_MAX_BYTES) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Skill "${skill.name}" exceeds the 32 KB limit.`,
              });
            }
          }
        }
        if (
          instructions !== undefined &&
          Buffer.byteLength(instructions, "utf8") > PLUGIN_INSTRUCTIONS_MAX_BYTES
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Instructions (AGENTS.md) exceed the 8 KB limit.",
          });
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
              ...(worker === undefined ? {} : { worker }),
              ...(skills === undefined ? {} : { skills }),
              ...(instructions === undefined ? {} : { instructions }),
            })
            .pipe(Effect.mapError(mapPluginError));
          const applied = result.plugin.enabled && result.plugin.problem === undefined;
          const missingFolders =
            result.plugin.worker?.folders.filter((folder) => folder.path === null) ?? [];
          const hasMissingFolders = missingFolders.length > 0;
          const workerSummary =
            result.plugin.worker === undefined
              ? undefined
              : {
                  ...(result.plugin.worker.everyMinutes === undefined
                    ? {}
                    : { everyMinutes: result.plugin.worker.everyMinutes }),
                  folders: result.plugin.worker.folders.map(({ id, label, access }) => ({
                    id,
                    label,
                    access,
                  })),
                  network: result.plugin.worker.network,
                };
          let next: string;
          if (result.created) {
            if (applied) {
              next = "Live now; the user can manage it from the card in the chat.";
            } else if (hasMissingFolders) {
              next =
                "The user turns it on with Install on the card in the chat, then picks its folder path(s) in Settings > Plugins before the worker can run.";
            } else {
              next = "The user turns it on with Install on the card in the chat.";
            }
          } else if (applied && result.plugin.worker?.status === "needs-approval") {
            next = hasMissingFolders
              ? "Saved; worker powers changed, so the user must click Approve on the card or in Settings > Plugins and pick its folder path(s) before it runs."
              : "Saved; worker powers changed, so the user must click Approve on the card or in Settings > Plugins before it runs.";
          } else if (applied && hasMissingFolders) {
            next =
              "Saved; the user still needs to pick its folder path(s) in Settings > Plugins before the worker can run.";
          } else if (applied) {
            next = "Live now; the user can Undo from the card.";
          } else if (hasMissingFolders) {
            next =
              "Saved; it is off, so the user turns it on and picks its folder path(s) in Settings > Plugins.";
          } else {
            next = "Saved; it is off, so turn it on in Settings > Plugins.";
          }
          return {
            pluginId,
            created: result.created,
            enabled: result.plugin.enabled,
            applied,
            contributes: result.plugin.contributes,
            ...(workerSummary === undefined ? {} : { worker: workerSummary }),
            ...(result.plugin.commands === undefined ? {} : { commands: result.plugin.commands }),
            ...(result.plugin.skills === undefined ? {} : { skills: result.plugin.skills }),
            ...(result.plugin.unsupported === undefined
              ? {}
              : { unsupported: result.plugin.unsupported }),
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
