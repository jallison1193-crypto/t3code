# Plugins

Plugins extend T3 Code from folders in your server's userdata directory. A plugin can add custom CSS that layers on top of your active theme, right panel tabs that render self-contained HTML, a background server worker, or any combination. Web and desktop clients load CSS and panels; workers run on the server. Mobile does not load plugins.

## Where plugins live

Each plugin is its own folder under `~/.t3/userdata/plugins/<id>/` (or `plugins/<id>/` under your custom state directory). **Settings → Plugins** shows the exact folder path for the selected environment.

## Manifest format

Inside each plugin folder, create `.t3-plugin/plugin.json`:

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

A plugin must declare at least one of `css`, `panels`, or `worker`. Unknown fields are ignored, so one folder can also carry manifests for other tools.

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
- **Controls and logs:** **Settings → Plugins** shows worker status, **Run now**, and a **Log** disclosure with the last 32 KB of output. A worker restarts with backoff up to 3 times on crash; turning the plugin off and on resets the crash count.

## Enabling, editing, and uninstalling

New plugins start **off**. Open **Settings → Plugins** to turn each plugin on or off.

- Enabling or disabling a plugin applies live in every connected web and desktop client of that environment.
- Edits to a plugin's manifest, CSS, panel HTML, or worker files on disk are picked up automatically.
- A plugin with a missing or invalid manifest, none of `css`, `panels`, or `worker`, a name that does not match its folder, invalid CSS, or a missing/invalid panel or worker entry still appears in **Settings → Plugins** with a problem message, its switch disabled, and no CSS, panels, or worker loaded.
- **Uninstall** asks for confirmation, removes the plugin's enabled setting, and moves the folder to `<stateDir>/plugins-archive/<id>-<timestamp>/` instead of deleting it. Saved panel and worker state under `<stateDir>/plugins-state/<id>/` is kept. To restore an uninstalled plugin, move the archived folder back to `<stateDir>/plugins/<id>/` by hand and turn it on again in **Settings → Plugins**.

## Creating and editing plugins with agents

You can ask an agent to create or update a CSS, panel, or worker plugin for you.

- A **new** plugin is saved disabled and shows a card in the chat listing what it adds, with **Install** to turn it on and **Cancel** to archive it. After **Install**, the card offers **Turn off**; after **Cancel**, it offers **Install anyway**.
- An **edit** to an existing plugin saves right away (and applies live if the plugin is enabled), with **Undo** on its card and **Restore** after undoing. If an edit widens worker powers, the card also shows **Approve** next to **Undo**.
- Each write and restore snapshots the plugin's manifest, CSS, panel HTML, and worker files under `<stateDir>/plugins-history/<id>/`, keeping the newest 20 revisions per plugin.
