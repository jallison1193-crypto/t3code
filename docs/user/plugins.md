# Plugins

Plugins extend T3 Code from folders in your server's userdata directory or from a project's repository. A plugin can add custom CSS that layers on top of your active theme, right panel tabs that render self-contained HTML, a background server worker, slash commands, agent skills, agent instructions (`AGENTS.md`), MCP servers, Claude hooks, Claude subagents, or any combination. Web and desktop clients load CSS, panels, and slash command suggestions; workers, command expansion, skills, instructions, and proxied MCP servers run on the server for every provider; hooks and subagents apply to Claude threads. Mobile does not load plugins.

## Where plugins live

User plugins live in their own folders under `~/.t3/userdata/plugins/<id>/` (or `plugins/<id>/` under your custom state directory). **Settings → Plugins** shows the exact folder path for the selected environment.

Repo plugins live inside a project repository under `<project root>/.t3/plugins/<id>/` (up to 16 folders per project) and apply only to that project's threads, including worktree threads.

## Manifest format

Inside each plugin folder, create `.t3-plugin/plugin.json` (or `.claude-plugin/plugin.json`; if both exist, `.t3-plugin/plugin.json` wins):

```json
{
  "name": "compact-sidebar",
  "displayName": "Compact sidebar",
  "description": "Tightens spacing on sidebar thread rows.",
  "version": "1.0.0",
  "css": "./plugin.css",
  "panels": [
    {
      "id": "timer",
      "title": "Pomodoro",
      "entry": "./timer.html"
    }
  ],
  "worker": {
    "entry": "./worker.mjs",
    "everyMinutes": 15,
    "folders": [{ "id": "vault", "label": "Obsidian vault folder", "access": "write" }],
    "network": false
  }
}
```

Fields:

- `name` (required): lowercase letters, digits, and hyphens, up to 64 characters. Must match the folder name.
- `displayName` (optional): single-line display name, up to 80 characters. Defaults to `name` when omitted.
- `description` (optional): short description, up to 300 characters.
- `version` (optional): single-line version string, up to 32 characters.
- `css` (optional): relative path starting with `./` pointing to a CSS file inside the plugin folder.
- `panels` (optional): 1 to 4 right panel tabs, each with `id` (lowercase letters, digits, and hyphens, unique within the plugin), `title` (single line, up to 40 characters), and `entry` (`./<name>.html` at the plugin folder root).
- `worker` (optional): background Node process with `entry` (`./<name>.mjs` at the plugin folder root), optional `everyMinutes` (integer 5 to 1440), optional `folders` (0 to 4 items `{ id, label, access: "read" | "write" }`), and optional `network` (boolean, default `false`).
- `mcpServers` (optional): inline MCP server map or a relative `./path.json` file inside the plugin folder (combined with `.mcp.json` at the plugin root).
- `hooks` (optional): inline Claude hooks event map or a relative `./path.json` file inside the plugin folder (combined with `hooks/hooks.json`).

A plugin must provide at least one supported part: `css`, `panels`, `worker`, skills, commands, `AGENTS.md`, MCP servers, hooks, or agents. Unknown fields are ignored, so one folder can also carry manifests for other tools.

## Slash commands, skills, and instructions

Plugins can include text parts that T3 delivers to every provider (Codex, Claude, Cursor, OpenCode, Antigravity, and others):

- **Skills (`skills/<name>/SKILL.md`) and legacy commands (`commands/<name>.md`):** Flat layout only (nested folders are ignored), up to 32 entries per plugin and 32 KB per file. If a skill folder name and a legacy command file name collide, the skill wins. Optional YAML frontmatter supports `name`, `description`, `argument-hint`, `disable-model-invocation` (`true` means only the user can run it as a slash command), and `user-invocable` (`false` hides it from the `/` menu). The effective name must match the plugin id pattern (lowercase letters, digits, hyphens).
- **Running slash commands:** Active user-invocable commands appear in the web and desktop composer `/` menu (short `/name` when unambiguous, or `/<plugin>:<name>` when two plugins share a name or collide with a T3 built-in like `/model`, `/side`, `/btw`, `/clear`, or `/compact`). When you send a matching command, the thread keeps showing what you typed while the provider receives the expanded body with frontmatter stripped and substitutions applied: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` (0-based), `${CLAUDE_PLUGIN_ROOT}`, `${T3_PLUGIN_ROOT}`, and `${CLAUDE_SKILL_DIR}`. If the body omits argument placeholders and you passed arguments, T3 appends `ARGUMENTS: <args>`.
- **Model-invocable skills:** Active skills without `disable-model-invocation: true` are listed in the project context sent to providers (up to a 2 KB sub-budget inside the 16 KB context limit) with their description and file path so the agent can read `SKILL.md` when relevant.
- **Instructions (`AGENTS.md`):** An optional `AGENTS.md` file at the plugin root (up to 8 KB) is added to the project context sent on every turn (up to a 6 KB sub-budget across active plugins, after project instructions and memory).

## MCP servers

A user plugin can declare up to 8 MCP servers in `.mcp.json` at the plugin root (`{"mcpServers": {...}}` or server names at the top level) or via manifest `mcpServers` (inline map or `./path.json`, up to 64 KiB per JSON file). Server names must match `[A-Za-z0-9_-]{1,40}`.

- **Transports:** Stdio servers take `command`, optional `args`, `env`, and `timeout` (ms). Remote servers require `type` (`"http"`, `"streamable-http"`, or `"sse"`) with `url`, optional `headers`, and `timeout` (ms). A `url` without `type` is rejected.
- **Variable expansion:** `command`, `args`, `env`, `url`, and `headers` expand `${CLAUDE_PLUGIN_ROOT}`, `${T3_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (per-plugin data folder under `<stateDir>/plugins-data/<id>`), `${VAR}`, and `${VAR:-default}` from the server environment; unset variables without a default stay literal. Stdio servers start with an allowlisted base environment (never `T3CODE_*` variables), the plugin path variables, and their declared `env`, with `shell: false`.
- **Shared proxy on `/mcp`:** T3 starts one shared connection per active server when the plugin is enabled and approved, and exposes its tools on T3's `/mcp` endpoint for every provider (up to 64 tools per server, 128 plugin tools total). Startup times out after 30 seconds; tool calls default to 120 seconds. Failed starts or crashes retry up to 3 times with backoff before showing **Failed** in **Settings → Plugins**; turning the plugin off and on resets retries.

## Hooks (Claude threads only)

A user plugin can declare Claude Code hooks in `hooks/hooks.json` (`{"hooks": {"<Event>": [{"matcher"?, "hooks": [handler]}]}}`) or via manifest `hooks` (inline event map or `./path.json`, up to 64 KiB per JSON file).

- Supported handler types: `command`, `http`, `mcp_tool`, `prompt`, and `agent`.
- `${CLAUDE_PLUGIN_ROOT}`, `${T3_PLUGIN_ROOT}`, and `${CLAUDE_PLUGIN_DATA}` are expanded in string fields when delivered to Claude turns.
- Plugin hooks are merged per event after any hooks in your Claude launch arguments without overwriting them. Other providers do not run plugin hooks.

## Agents (Claude threads only)

User plugins and enabled repo plugins can define up to 16 flat subagent markdown files under `agents/*.md` (up to 32 KiB each). Frontmatter requires `description` and accepts optional `name`, `tools`, `disallowedTools`, `model`, `effort`, and `maxTurns`; the body is the agent's prompt. Power keys inside agent frontmatter (`hooks`, `mcpServers`, `permissionMode`) are ignored. T3 passes active agents to Claude threads as `<plugin>:<name>`. Other providers do not load plugin agents.

## Approval for MCP servers and hooks

MCP servers and hooks run outside the sandbox on the server machine.

- **Off until approved:** A plugin with MCP servers or hooks starts unapproved. Until you approve it, its MCP servers do not start and its hooks are not delivered, while its CSS, panels, commands, skills, instructions, and agents still work.
- **Approving and revoking:** Clicking **Install** on a chat card enables the plugin and approves its current MCP and hook config. In **Settings → Plugins**, click **Approve** to allow them or **Remove approval** to revoke approval and stop running servers and hooks while leaving the rest of the plugin on.
- **Re-asked on config changes:** Approval is tied to a hash of the normalized MCP and hook config. Any change to those files or manifest fields stops the servers and hooks until you click **Approve** again. Text-only edits apply immediately without re-asking.

## What is not supported

- **Inside MCP server configs:** OAuth (`oauth`), `headersHelper`, WebSocket (`ws`) transport, `.mcpb`/`.dxt` URLs, `${CLAUDE_PROJECT_DIR}`, and `${user_config.*}`. Servers using these are marked **Not runnable** with a reason while the rest of the plugin keeps loading. MCP resources and prompts are not proxied.
- **Outside Claude:** Hooks and subagents apply only in Claude threads.
- **In repo plugins:** MCP servers, hooks, CSS, panels, and workers are not supported in repo plugins.

## Repo plugins and trust

A repository can ship team commands, skills, instructions, and Claude subagents in `<project root>/.t3/plugins/<id>/`:

- **Off by default:** Repo plugins never apply until you turn them on in **Settings → Plugins** under **Repo plugins**.
- **Re-checked on change:** Turning a repo plugin on approves its exact content revision. If any file in the plugin changes (for example after `git pull` or an edit), T3 stops applying it and shows **Changed since you turned it on** with **Turn on again** in **Settings → Plugins**.
- **Text parts only:** Repo plugins load only skills, commands, `AGENTS.md`, and `agents/*.md`. Any `css`, `panels`, `worker`, `mcp`, or `hooks` entries in a repo plugin are ignored and noted as not supported in repo plugins.
- **Managed by the repo:** Repo plugins cannot be uninstalled or restored through T3; turn them off in Settings or edit them in the repository.

## Claude Code plugin folders

Folders with only `.claude-plugin/plugin.json` load as T3 plugins, including `skills/`, `commands/`, `AGENTS.md`, `agents/`, `.mcp.json` (or manifest `mcpServers`), and `hooks/hooks.json` (or manifest `hooks`). MCP servers and hooks stay off until you approve them in **Settings → Plugins** or from the install card.

## CSS rules

Plugin CSS follows the same limits and safety checks as theme custom CSS:

- Up to 100,000 characters per plugin.
- No remote file loading: `@import`, `image-set()`, and `url()` other than `data:` or `#id` are rejected by the server and stripped by the client.
- Symlinked plugin folders, manifests, and CSS files are not loaded, and paths cannot escape the plugin folder.
- Enabled plugin stylesheets apply after the active theme's CSS.

## Panels

A plugin with `panels` in `.t3-plugin/plugin.json` adds tabs you can open in the right panel:

- **Opening a panel:** Open the `+` menu in the right panel and pick any panel from an enabled plugin. Opening a panel that is already open focuses its tab.
- **Sandboxing:** Panel pages run in a sandboxed iframe with no network access and no access to T3 Code's page origin. Symlinked HTML files, paths outside the plugin folder root, and files over 2 MiB are rejected.
- **Saved state:** Panels can store JSON state (up to 64 KB per scope, scoped globally or per project) on the server, synced live across tabs, reloads, and devices. State is saved under `<stateDir>/plugins-state/<id>/` (`global.json` and `project-<projectId>.json`) and stays in place if you uninstall the plugin so restoring the plugin brings its data back.
- **Turning off a plugin:** If you disable or uninstall a plugin while its tab is open, the tab shows a message linking to **Settings → Plugins** instead of running the page, and can still be closed.
- **Building panels with agents:** You can ask an agent to build or edit a panel plugin (for example, a Pomodoro timer or checklist) and install it from the card in chat.

## Workers

A plugin with `worker` in `.t3-plugin/plugin.json` runs background ES module code on the server in its own Node child process locked to the plugin folder and the server-machine folders you grant:

- **Approval and folders:** Install enables the plugin and approves its declared powers (`folders`, `network`, and `everyMinutes`). If an edit changes those powers, the worker stops until you click **Approve** on the chat card or in **Settings → Plugins**. Set each declared folder path on the server machine in **Settings → Plugins**; UNC paths are refused and symlinks are resolved before granting access.
- **Seat belt:** Node's permission model keeps trusted plugin code out of other folders, and blocks network access when the server runtime supports `--allow-net`. On runtimes that cannot block network access, Settings and the install card note that network access is not blocked. Only turn on plugins you trust.
- **Worker code:** `worker.mjs` default-exports a function that receives `t3`: `t3.onRun(fn)` registers the run handler (called with `{ reason }`: `start`, `schedule`, or `manual`), `t3.folders` maps folder ids to granted paths, `t3.state.get()`/`set()` saves up to 64 KB, `t3.projects.list()` and `t3.projects.readMemory(id)` read projects and their memory, and `t3.log()` and `console` write to the log. A run times out after 5 minutes, and runs never overlap.
- **Controls and logs:** **Settings → Plugins** shows worker status, **Run now**, and a **Log** disclosure with the last 32 KB of output. A worker restarts with backoff up to 3 times on crash; turning the plugin off and on resets the crash count.

## Enabling, editing, and uninstalling

New plugins start **off**. Open **Settings → Plugins** to turn each plugin on or off.

- Enabling or disabling a plugin applies live in every connected web and desktop client of that environment.
- Edits to a user plugin's manifest, CSS, panel HTML, worker, skills, commands, `AGENTS.md`, `.mcp.json`, `hooks/hooks.json`, or `agents/` files on disk are picked up automatically.
- Invalid or oversized MCP, hook, or agent configs are reported as part problems on the plugin without blocking its other parts. A plugin with a missing or invalid manifest, no supported parts, a name that does not match its folder, invalid CSS, a missing/invalid panel or worker entry, invalid or oversized skills/commands, or oversized `AGENTS.md` still appears in **Settings → Plugins** with a problem message, its switch disabled, and no parts loaded.
- **Uninstall** asks for confirmation, stops running workers and MCP servers, removes the plugin's enabled setting, and moves the folder to `<stateDir>/plugins-archive/<id>-<timestamp>/` instead of deleting it. Saved panel and worker state under `<stateDir>/plugins-state/<id>/` is kept. To restore an uninstalled plugin, move the archived folder back to `<stateDir>/plugins/<id>/` by hand and turn it on again in **Settings → Plugins**.

## Creating and editing plugins with agents

You can ask an agent to create or update a CSS, panel, worker, command, skill, instructions, MCP server, hook, or agent plugin for you (for example, "add a /standup command").

- A **new** plugin is saved disabled and shows a card in the chat listing what it adds, with **Install** to turn it on and **Cancel** to archive it. After **Install**, the card offers **Turn off**; after **Cancel**, it offers **Install anyway**.
- An **edit** to an existing plugin saves right away (and applies live if the plugin is enabled), with **Undo** on its card and **Restore** after undoing. If an edit changes worker powers or MCP/hook config, those parts stop and the card also shows **Approve** next to **Undo**.
- Each write and restore snapshots the plugin's manifest, CSS, panel HTML, worker, `AGENTS.md`, skills, commands, MCP config, hooks config, and agents under `<stateDir>/plugins-history/<id>/`, keeping the newest 20 revisions per plugin.
