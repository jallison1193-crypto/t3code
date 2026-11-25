import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const BOTS_DISABLED_REASON = "Bots are turned off in Settings";
export const BOT_PAUSED_REASON = "This bot is paused";

const SingleLineBotName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^\r\n\v\f\u0085\u2028\u2029]+$/u),
);

/** Marker stored on `ProjectSettingsOverrides.bot`. Its presence makes a project a bot. */
export const BotProfile = Schema.Struct({
  paused: Schema.optionalKey(Schema.Boolean),
});
export type BotProfile = typeof BotProfile.Type;

export const BotRecord = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  goal: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  paused: Schema.Boolean,
  workspaceRoot: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotRecord = typeof BotRecord.Type;

export const BotCreateInput = Schema.Struct({
  name: SingleLineBotName,
  goal: Schema.optionalKey(TrimmedString),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  projectId: ProjectId,
  name: Schema.optionalKey(SingleLineBotName),
  goal: Schema.optionalKey(TrimmedString),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  paused: Schema.optionalKey(Schema.Boolean),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotDeleteInput = Schema.Struct({
  projectId: ProjectId,
});
export type BotDeleteInput = typeof BotDeleteInput.Type;

export const BotDeleteResult = Schema.Struct({
  projectId: ProjectId,
  deletedScheduledTaskIds: Schema.Array(Schema.String),
});
export type BotDeleteResult = typeof BotDeleteResult.Type;

export const BotErrorReason = Schema.Literals([
  "bots_disabled",
  "not_found",
  "not_a_bot",
  "invalid_name",
  "folder_failed",
  "project_failed",
  "settings_failed",
  "scheduled_tasks_failed",
]);
export type BotErrorReason = typeof BotErrorReason.Type;

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  {
    operation: Schema.Literals(["list", "get", "create", "update", "delete"]),
    reason: BotErrorReason,
    projectId: Schema.optional(ProjectId),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "bots_disabled":
        return BOTS_DISABLED_REASON;
      case "not_found":
        return "Bot not found.";
      case "not_a_bot":
        return "That project is not a bot.";
      case "invalid_name":
        return "Bot name must be a non-empty single line.";
      case "folder_failed":
        return this.detail ?? "Could not create a folder for the bot.";
      case "project_failed":
        return this.detail ?? "Could not update the bot project.";
      case "settings_failed":
        return this.detail ?? "Could not save bot settings.";
      case "scheduled_tasks_failed":
        return this.detail ?? "Could not remove the bot's scheduled tasks.";
    }
  }
}

type BotSettingsView = {
  readonly botsEnabled?: boolean | undefined;
  readonly projectSettingsOverrides?:
    | Readonly<Record<string, { readonly bot?: BotProfile | undefined } | undefined>>
    | undefined;
};

export function isBotProject(
  settings: Pick<BotSettingsView, "projectSettingsOverrides"> | null | undefined,
  projectId: ProjectId | string | null | undefined,
): boolean {
  if (!settings?.projectSettingsOverrides || !projectId) return false;
  return settings.projectSettingsOverrides[projectId]?.bot !== undefined;
}

export function isBotPaused(
  settings: Pick<BotSettingsView, "projectSettingsOverrides"> | null | undefined,
  projectId: ProjectId | string | null | undefined,
): boolean {
  if (!settings?.projectSettingsOverrides || !projectId) return false;
  return settings.projectSettingsOverrides[projectId]?.bot?.paused === true;
}

export function botTriggerBlockReason(
  settings: BotSettingsView | null | undefined,
  projectId: ProjectId | string | null | undefined,
): string | undefined {
  if (!isBotProject(settings, projectId)) return undefined;
  if (settings?.botsEnabled === false) return BOTS_DISABLED_REASON;
  if (isBotPaused(settings, projectId)) return BOT_PAUSED_REASON;
  return undefined;
}
