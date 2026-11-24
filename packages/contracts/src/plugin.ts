import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PLUGIN_MANIFEST_DIR = ".t3-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_MAX_PANELS = 4;
const PLUGIN_PANEL_TITLE_MAX_LENGTH = 40;
export const PLUGIN_PANEL_HTML_MAX_CHARS = 200_000;
export const PLUGIN_STATE_MAX_BYTES = 64 * 1024;

const SingleLineTrimmedNonEmptyString = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[^\r\n\v\f\u0085\u2028\u2029]+$/u),
);

const PluginIdChecked = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

// Decode from raw String so Schema.Record rejects invalid plugin ids instead of silently dropping them.
export const PluginId = Schema.String.pipe(
  Schema.decodeTo(PluginIdChecked, SchemaTransformation.passthrough()),
);
export type PluginId = typeof PluginId.Type;

export const PluginContribution = Schema.Literals(["css", "panel"]);
export type PluginContribution = typeof PluginContribution.Type;

const PluginPanelTitle = SingleLineTrimmedNonEmptyString.check(
  Schema.isMaxLength(PLUGIN_PANEL_TITLE_MAX_LENGTH),
);

const PluginPanelEntryPath = SingleLineTrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^\.\/(?!\.)[^/\\\0]+\.html$/),
);

const PluginManifestPanel = Schema.Struct({
  id: PluginId,
  title: PluginPanelTitle,
  entry: PluginPanelEntryPath,
});

const hasUniquePanelIds = Schema.makeFilter(
  (panels: ReadonlyArray<typeof PluginManifestPanel.Type>) => {
    const seen = new Set<string>();
    for (const panel of panels) {
      if (seen.has(panel.id)) return false;
      seen.add(panel.id);
    }
    return true;
  },
  { expected: "panels with unique ids" },
);

export const PluginManifest = Schema.Struct({
  name: PluginId,
  displayName: Schema.optional(SingleLineTrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  version: Schema.optional(SingleLineTrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  css: Schema.optional(SingleLineTrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  panels: Schema.optional(
    Schema.Array(PluginManifestPanel).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PLUGIN_MAX_PANELS),
      hasUniquePanelIds,
    ),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginSettingEntry = Schema.Struct({
  enabled: Schema.Boolean,
});
export type PluginSettingEntry = typeof PluginSettingEntry.Type;

export const InstalledPluginPanel = Schema.Struct({
  id: PluginId,
  title: PluginPanelTitle,
});
export type InstalledPluginPanel = typeof InstalledPluginPanel.Type;

export const InstalledPlugin = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  contributes: Schema.Array(PluginContribution),
  panels: Schema.optional(Schema.Array(InstalledPluginPanel)),
  revision: Schema.optional(TrimmedNonEmptyString),
  problem: Schema.optional(TrimmedNonEmptyString),
});
export type InstalledPlugin = typeof InstalledPlugin.Type;

export const EnvironmentPlugin = Schema.Struct({
  id: PluginId,
  css: Schema.String,
  panels: Schema.optional(Schema.Array(InstalledPluginPanel)),
});
export type EnvironmentPlugin = typeof EnvironmentPlugin.Type;

export const PluginStateScope = Schema.Union([
  Schema.Literal("global"),
  Schema.Struct({ projectId: ProjectId }),
]);
export type PluginStateScope = typeof PluginStateScope.Type;

export const ServerListPluginsResult = Schema.Struct({
  pluginsDir: TrimmedNonEmptyString,
  plugins: Schema.Array(InstalledPlugin),
});
export type ServerListPluginsResult = typeof ServerListPluginsResult.Type;

export const ServerSetPluginEnabledInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ServerSetPluginEnabledInput = typeof ServerSetPluginEnabledInput.Type;

export const ServerSetPluginEnabledResult = Schema.Struct({
  plugin: InstalledPlugin,
});
export type ServerSetPluginEnabledResult = typeof ServerSetPluginEnabledResult.Type;

export const ServerUninstallPluginInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type ServerUninstallPluginInput = typeof ServerUninstallPluginInput.Type;

export const ServerUninstallPluginResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  archivedTo: TrimmedNonEmptyString,
});
export type ServerUninstallPluginResult = typeof ServerUninstallPluginResult.Type;

export const ServerRestorePluginRevisionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  enable: Schema.optional(Schema.Boolean),
});
export type ServerRestorePluginRevisionInput = typeof ServerRestorePluginRevisionInput.Type;

export const ServerRestorePluginRevisionResult = Schema.Struct({
  plugin: InstalledPlugin,
});
export type ServerRestorePluginRevisionResult = typeof ServerRestorePluginRevisionResult.Type;

export const ServerGetPluginStateInput = Schema.Struct({
  pluginId: PluginId,
  scope: PluginStateScope,
});
export type ServerGetPluginStateInput = typeof ServerGetPluginStateInput.Type;

export const ServerGetPluginStateResult = Schema.Struct({
  value: Schema.Unknown,
});
export type ServerGetPluginStateResult = typeof ServerGetPluginStateResult.Type;

export const ServerSetPluginStateInput = Schema.Struct({
  pluginId: PluginId,
  scope: PluginStateScope,
  value: Schema.Unknown,
});
export type ServerSetPluginStateInput = typeof ServerSetPluginStateInput.Type;

export const ServerSetPluginStateResult = Schema.Struct({
  ok: Schema.Literal(true),
});
export type ServerSetPluginStateResult = typeof ServerSetPluginStateResult.Type;

export const ServerSubscribePluginStateInput = Schema.Struct({
  pluginId: PluginId,
  scope: PluginStateScope,
});
export type ServerSubscribePluginStateInput = typeof ServerSubscribePluginStateInput.Type;

export const ServerPluginStateSnapshot = Schema.Struct({
  value: Schema.Unknown,
});
export type ServerPluginStateSnapshot = typeof ServerPluginStateSnapshot.Type;

export class PluginOperationError extends Schema.TaggedError<PluginOperationError>()(
  "PluginOperationError",
  {
    pluginId: Schema.optional(Schema.String),
    operation: Schema.Literals([
      "list",
      "read",
      "write",
      "restore",
      "setEnabled",
      "uninstall",
      "resolvePanelEntry",
    ]),
    reason: Schema.Literals([
      "not_found",
      "invalid_id",
      "invalid_css",
      "invalid_panel",
      "has_problem",
      "settings_failed",
      "archive_failed",
      "write_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const id = this.pluginId ?? "";
    switch (this.reason) {
      case "not_found":
        return this.operation === "restore"
          ? `Revision for plugin "${id}" was not found.`
          : this.operation === "resolvePanelEntry"
            ? `Panel for plugin "${id}" was not found.`
            : `Plugin "${id}" is not installed.`;
      case "invalid_id":
        return `Plugin "${id}" is not a valid plugin id.`;
      case "invalid_css":
        return `CSS for plugin "${id}" exceeds the size limit or loads remote files.`;
      case "invalid_panel":
        return `Panel definition for plugin "${id}" is invalid or exceeds the HTML size limit.`;
      case "has_problem":
        return this.operation === "setEnabled"
          ? `Plugin "${id}" has a problem and cannot be enabled.`
          : `Plugin "${id}" has a problem and cannot be accessed.`;
      case "settings_failed":
        return `Could not save settings for plugin "${id}".`;
      case "archive_failed":
        return `Could not archive plugin "${id}".`;
      case "write_failed":
        return `Could not write files for plugin "${id}".`;
    }
  }
}

export class PluginStateError extends Schema.TaggedError<PluginStateError>()("PluginStateError", {
  pluginId: Schema.String,
  operation: Schema.Literals(["get", "set", "subscribe"]),
  reason: Schema.Literals([
    "invalid_id",
    "invalid_scope",
    "not_found",
    "invalid_value",
    "state_too_large",
    "read_failed",
    "write_failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_id":
        return `Plugin "${this.pluginId}" is not a valid plugin id.`;
      case "invalid_scope":
        return `State scope for plugin "${this.pluginId}" is invalid.`;
      case "not_found":
        return `Plugin "${this.pluginId}" is not installed.`;
      case "invalid_value":
        return `State value for plugin "${this.pluginId}" must be JSON.`;
      case "state_too_large":
        return `State for plugin "${this.pluginId}" exceeds the 64 KB limit.`;
      case "read_failed":
        return `Could not read state for plugin "${this.pluginId}".`;
      case "write_failed":
        return `Could not save state for plugin "${this.pluginId}".`;
    }
  }
}
