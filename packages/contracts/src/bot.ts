import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { ProviderDriverKind } from "./providerInstance.ts";

export const BOTS_DISABLED_REASON = "Bots are turned off in Settings";
export const BOT_PAUSED_REASON = "This bot is paused";
export const BOT_DAILY_RUN_LIMIT_REASON = "Daily run limit reached";
export const BOT_DAILY_TOKEN_LIMIT_REASON = "Daily token limit reached";
export const BOT_UNSUPPORTED_PROVIDER_REASON = "This provider is not supported for bots.";

export const BotGateUnsupportedReasonCode = Schema.Literals([
  "no_approval_callback",
  "ungated_mcp_or_tools",
  "unisolated_user_rules",
  "opaque_subagents_or_mcp",
  "unverified_third_party_acp",
  "provider_unavailable",
]);
export type BotGateUnsupportedReasonCode = typeof BotGateUnsupportedReasonCode.Type;

export const BotGateCapability = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("supported"),
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    reasonCode: BotGateUnsupportedReasonCode,
  }),
]);
export type BotGateCapability = typeof BotGateCapability.Type;

export const DEFAULT_UNSUPPORTED_BOT_GATE: BotGateCapability = {
  status: "unsupported",
  reasonCode: "unverified_third_party_acp",
};

export const BotBlockReasonCode = Schema.Literals([
  "bots_disabled",
  "paused",
  "daily_run_limit",
  "daily_token_limit",
  ...BotGateUnsupportedReasonCode.literals,
]);
export type BotBlockReasonCode = typeof BotBlockReasonCode.Type;

const BOT_GATE_UNSUPPORTED_FALLBACK_REASONS: Readonly<
  Record<BotGateUnsupportedReasonCode, string>
> = {
  no_approval_callback:
    "This provider does not support interactive tool approvals for T3's bot safety gate.",
  ungated_mcp_or_tools:
    "This provider can run some tools or MCP calls without T3's bot safety gate.",
  unisolated_user_rules:
    "This provider can apply user or workspace rules that bypass T3's bot safety gate.",
  opaque_subagents_or_mcp:
    "This provider runs subagents or profile MCP servers outside T3's bot safety gate.",
  unverified_third_party_acp: "This provider has not been verified for T3's bot safety gate.",
  provider_unavailable: "This bot's provider is not available.",
};

export function botGateUnsupportedFallbackReason(reasonCode: BotGateUnsupportedReasonCode): string {
  return BOT_GATE_UNSUPPORTED_FALLBACK_REASONS[reasonCode];
}

// Legacy fallback when talking to an older server that omits `ServerProvider.botGate`.
const LEGACY_BOT_SUPPORTED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export function resolveBotGateCapability(
  snapshot:
    | {
        readonly driver?: ProviderDriverKind | string | null | undefined;
        readonly botGate?: BotGateCapability | undefined;
      }
    | null
    | undefined,
): BotGateCapability {
  if (snapshot == null) {
    return { status: "unsupported", reasonCode: "provider_unavailable" };
  }
  if (snapshot.botGate !== undefined) {
    return snapshot.botGate;
  }
  return typeof snapshot.driver === "string" && LEGACY_BOT_SUPPORTED_DRIVERS.has(snapshot.driver)
    ? { status: "supported" }
    : DEFAULT_UNSUPPORTED_BOT_GATE;
}

export const BotApprovalsMode = Schema.Literals(["t3_gate", "provider"]);
export type BotApprovalsMode = typeof BotApprovalsMode.Type;

export function resolveBotApprovalsMode(
  profile: { readonly approvals?: BotApprovalsMode | undefined } | null | undefined,
): BotApprovalsMode {
  return profile?.approvals ?? "t3_gate";
}

export const BotLimitMode = Schema.Literals(["runs_and_tokens", "runs_only", "none"]);
export type BotLimitMode = typeof BotLimitMode.Type;

export const BotLimits = Schema.Struct({
  mode: BotLimitMode,
  runsPerDay: Schema.optionalKey(PositiveInt),
  tokensPerDay: Schema.optionalKey(PositiveInt),
});
export type BotLimits = typeof BotLimits.Type;

export interface ResolvedBotLimits {
  readonly mode: BotLimitMode;
  readonly runsPerDay: number;
  readonly tokensPerDay: number;
}

export const DEFAULT_BOT_LIMITS: ResolvedBotLimits = {
  mode: "runs_and_tokens",
  runsPerDay: 24,
  tokensPerDay: 2_000_000,
};

export function resolveBotLimits(
  profile: { readonly limits?: BotLimits | undefined } | null | undefined,
): ResolvedBotLimits {
  const limits = profile?.limits;
  if (limits === undefined) return DEFAULT_BOT_LIMITS;
  return {
    mode: limits.mode,
    runsPerDay: limits.runsPerDay ?? DEFAULT_BOT_LIMITS.runsPerDay,
    tokensPerDay: limits.tokensPerDay ?? DEFAULT_BOT_LIMITS.tokensPerDay,
  };
}

export const BotDailyUsage = Schema.Struct({
  runs: NonNegativeInt,
  tokens: NonNegativeInt,
  dayStartAt: IsoDateTime,
});
export type BotDailyUsage = typeof BotDailyUsage.Type;

export const BotGetUsageInput = Schema.Struct({
  projectId: ProjectId,
});
export type BotGetUsageInput = typeof BotGetUsageInput.Type;

export const BotUsageResult = Schema.Struct({
  projectId: ProjectId,
  limits: BotLimits,
  usage: BotDailyUsage,
  /** Why Run now is refused right now. */
  blockedByPolicy: Schema.optionalKey(Schema.String),
  blockedReasonCode: Schema.optionalKey(BotBlockReasonCode),
});
export type BotUsageResult = typeof BotUsageResult.Type;

const SingleLineBotName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^\r\n\v\f\u0085\u2028\u2029]+$/u),
);

/** Marker stored on `ProjectSettingsOverrides.bot`. Its presence makes a project a bot. */
export const BotProfile = Schema.Struct({
  paused: Schema.optionalKey(Schema.Boolean),
  limits: Schema.optionalKey(BotLimits),
  approvals: Schema.optionalKey(BotApprovalsMode),
});
export type BotProfile = typeof BotProfile.Type;

export const BotDefaults = Schema.Struct({
  modelSelection: Schema.optionalKey(ModelSelection),
  limits: Schema.optionalKey(BotLimits),
});
export type BotDefaults = typeof BotDefaults.Type;

export const BotDefaultsPatch = Schema.Struct({
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  limits: Schema.optionalKey(Schema.NullOr(BotLimits)),
});
export type BotDefaultsPatch = typeof BotDefaultsPatch.Type;

export const BotRecord = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  goal: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  paused: Schema.Boolean,
  limits: Schema.optionalKey(BotLimits),
  approvals: Schema.optionalKey(BotApprovalsMode),
  workspaceRoot: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotRecord = typeof BotRecord.Type;

export const BotCreateInput = Schema.Struct({
  name: SingleLineBotName,
  goal: Schema.optionalKey(TrimmedString),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  limits: Schema.optionalKey(BotLimits),
  approvals: Schema.optionalKey(BotApprovalsMode),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  projectId: ProjectId,
  name: Schema.optionalKey(SingleLineBotName),
  goal: Schema.optionalKey(TrimmedString),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  paused: Schema.optionalKey(Schema.Boolean),
  limits: Schema.optionalKey(BotLimits),
  approvals: Schema.optionalKey(BotApprovalsMode),
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

export const BotRunInput = Schema.Struct({
  projectId: ProjectId,
  /** First message of the run. The bot's goal is already part of its instructions. */
  prompt: TrimmedNonEmptyString,
  /** Used only when neither the bot nor the environment has a default model. */
  fallbackModelSelection: Schema.optionalKey(ModelSelection),
});
export type BotRunInput = typeof BotRunInput.Type;

export const BotRunResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type BotRunResult = typeof BotRunResult.Type;

export const BotErrorReason = Schema.Literals([
  "bots_disabled",
  "not_found",
  "not_a_bot",
  "invalid_name",
  "folder_failed",
  "project_failed",
  "settings_failed",
  "scheduled_tasks_failed",
  "blocked",
  "no_model",
  "run_failed",
]);
export type BotErrorReason = typeof BotErrorReason.Type;

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  {
    operation: Schema.Literals(["list", "get", "getUsage", "create", "update", "delete", "run"]),
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
      case "blocked":
        return this.detail ?? "This bot can't run right now.";
      case "no_model":
        return "Choose a model for this bot before running it.";
      case "run_failed":
        return this.detail ?? "Could not start the run.";
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
