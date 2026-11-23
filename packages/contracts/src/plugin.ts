import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PLUGIN_MANIFEST_DIR = ".t3-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";

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

export const PluginContribution = Schema.Literals(["css"]);
export type PluginContribution = typeof PluginContribution.Type;

export const PluginManifest = Schema.Struct({
  name: PluginId,
  displayName: Schema.optional(SingleLineTrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  version: Schema.optional(SingleLineTrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  css: Schema.optional(SingleLineTrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginSettingEntry = Schema.Struct({
  enabled: Schema.Boolean,
});
export type PluginSettingEntry = typeof PluginSettingEntry.Type;

export const InstalledPlugin = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  contributes: Schema.Array(PluginContribution),
  problem: Schema.optional(TrimmedNonEmptyString),
});
export type InstalledPlugin = typeof InstalledPlugin.Type;

export const EnvironmentPlugin = Schema.Struct({
  id: PluginId,
  css: Schema.String,
});
export type EnvironmentPlugin = typeof EnvironmentPlugin.Type;

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

export class PluginOperationError extends Schema.TaggedError<PluginOperationError>()(
  "PluginOperationError",
  {
    pluginId: Schema.optional(Schema.String),
    operation: Schema.Literals(["list", "setEnabled", "uninstall"]),
    reason: Schema.Literals([
      "not_found",
      "invalid_id",
      "has_problem",
      "settings_failed",
      "archive_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const id = this.pluginId ?? "";
    switch (this.reason) {
      case "not_found":
        return `Plugin "${id}" is not installed.`;
      case "invalid_id":
        return `Plugin "${id}" is not a valid plugin id.`;
      case "has_problem":
        return `Plugin "${id}" has a problem and cannot be enabled.`;
      case "settings_failed":
        return `Could not save settings for plugin "${id}".`;
      case "archive_failed":
        return `Could not archive plugin "${id}".`;
    }
  }
}
