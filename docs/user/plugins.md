# Plugins

Plugins extend T3 Code from folders in your server's userdata directory. Today a plugin can add custom CSS that layers on top of your active theme in web and desktop clients. Mobile does not load plugins.

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
  "css": "./plugin.css"
}
```

Fields:

- `name` (required): lowercase letters, digits, and hyphens, up to 64 characters. Must match the folder name.
- `displayName` (optional): single-line display name, up to 80 characters. Defaults to `name` when omitted.
- `description` (optional): short description, up to 300 characters.
- `version` (optional): single-line version string, up to 32 characters.
- `css` (optional): relative path starting with `./` pointing to a CSS file inside the plugin folder.

Unknown fields are ignored, so one folder can also carry manifests for other tools.

## CSS rules

Plugin CSS follows the same limits and safety checks as theme custom CSS:

- Up to 100,000 characters per plugin.
- No remote file loading: `@import`, `image-set()`, and `url()` other than `data:` or `#id` are rejected by the server and stripped by the client.
- Symlinked plugin folders, manifests, and CSS files are not loaded, and paths cannot escape the plugin folder.
- Enabled plugin stylesheets apply after the active theme's CSS.

## Enabling, editing, and uninstalling

New plugins start **off**. Open **Settings → Plugins** to turn each plugin on or off.

- Enabling or disabling a plugin applies live in every connected web and desktop client of that environment.
- Edits to a plugin's manifest or CSS file on disk are picked up automatically.
- A plugin with a missing or invalid manifest, a name that does not match its folder, or invalid CSS still appears in **Settings → Plugins** with a problem message, its switch disabled, and no CSS applied.
- **Uninstall** asks for confirmation, removes the plugin's enabled setting, and moves the folder to `<stateDir>/plugins-archive/<id>-<timestamp>/` instead of deleting it. To restore an uninstalled plugin, move the archived folder back to `<stateDir>/plugins/<id>/` by hand and turn it on again in **Settings → Plugins**.
