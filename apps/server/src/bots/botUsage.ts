import {
  BOT_DAILY_RUN_LIMIT_REASON,
  BOT_DAILY_TOKEN_LIMIT_REASON,
  BOT_PAUSED_REASON,
  BOTS_DISABLED_REASON,
  DEFAULT_UNSUPPORTED_BOT_GATE,
  type BotBlockReasonCode,
  type BotDailyUsage,
  type BotGateCapability,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettings,
  botGateUnsupportedFallbackReason,
  isBotPaused,
  isBotProject,
  resolveBotApprovalsMode,
  resolveBotLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

export interface BotTriggerBlock {
  readonly reason: string;
  readonly reasonCode?: BotBlockReasonCode | undefined;
  readonly allowManualRun: boolean;
}

export type BotGateResolver = (
  instanceId: ProviderInstanceId,
) => Effect.Effect<BotGateCapability | undefined>;

export function makeBotGateResolver(
  providerInstancesOption: Option.Option<
    ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]
  >,
): BotGateResolver | undefined {
  return Option.match(providerInstancesOption, {
    onNone: () => undefined,
    onSome: (registry) => (instanceId) =>
      registry.getInstance(instanceId).pipe(
        Effect.flatMap((instance) =>
          instance === undefined
            ? Effect.succeed<BotGateCapability>({
                status: "unsupported",
                reasonCode: "provider_unavailable",
              })
            : instance.snapshot.getSnapshot.pipe(
                Effect.map((snapshot) => snapshot.botGate ?? DEFAULT_UNSUPPORTED_BOT_GATE),
              ),
        ),
      ),
  });
}

/** Local midnight on the server for the given instant, converted to UTC for SQLite ISO comparisons. */
export function localDayStartUtc(now: DateTime.DateTime): DateTime.Utc {
  const zoned = DateTime.isZoned(now) ? now : DateTime.setZone(now, DateTime.zoneMakeLocal());
  return DateTime.toUtc(DateTime.startOf(zoned, "day"));
}

/**
 * Counts today's trigger runs (scheduled + webhook, excluding manual Run now) and
 * today's token usage across all turns in the bot's project since local midnight.
 * Scoped by `project_id` and day start; never scans other projects' threads.
 */
export const queryBotDailyUsage = Effect.fn("BotUsage.queryDailyUsage")(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  now: DateTime.DateTime,
): Effect.fn.Return<BotDailyUsage, never> {
  const dayStart = localDayStartUtc(now);
  const dayStartIso = DateTime.formatIso(dayStart);

  const [runRows, tokenRows] = yield* Effect.all([
    sql<{ readonly run_count: number | null }>`
      SELECT COUNT(*) AS run_count
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_messages m
        ON m.thread_id = t.thread_id
      WHERE t.project_id = ${projectId}
        AND m.created_at >= ${dayStartIso}
        AND json_extract(m.payload_json, '$.scheduledTaskId') IS NOT NULL
        AND m.message_id NOT LIKE '%:manual'
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => [{ run_count: 0 }]),
    ),
    sql<{ readonly total_tokens: number | null }>`
      SELECT COALESCE(SUM(
        CASE
          WHEN json_extract(pt.payload_json, '$.turnTokenUsage') IS NOT NULL THEN
            COALESCE(CAST(json_extract(pt.payload_json, '$.turnTokenUsage.inputTokens') AS INTEGER), 0)
            + COALESCE(CAST(json_extract(pt.payload_json, '$.turnTokenUsage.outputTokens') AS INTEGER), 0)
            + COALESCE(CAST(json_extract(pt.payload_json, '$.turnTokenUsage.otherUsage.inputTokens') AS INTEGER), 0)
            + COALESCE(CAST(json_extract(pt.payload_json, '$.turnTokenUsage.otherUsage.outputTokens') AS INTEGER), 0)
          WHEN json_extract(pt.payload_json, '$.tokenUsage') IS NOT NULL THEN
            COALESCE(
              CAST(json_extract(pt.payload_json, '$.tokenUsage.inputTokens') AS INTEGER)
                + CAST(json_extract(pt.payload_json, '$.tokenUsage.outputTokens') AS INTEGER),
              CAST(json_extract(pt.payload_json, '$.tokenUsage.usedTokens') AS INTEGER),
              0
            )
          ELSE 0
        END
      ), 0) AS total_tokens
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_turns pt
        ON pt.thread_id = t.thread_id
      WHERE t.project_id = ${projectId}
        AND COALESCE(pt.completed_at, pt.started_at) >= ${dayStartIso}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.orElseSucceed(() => [{ total_tokens: 0 }]),
    ),
  ]);

  const runs = Math.max(0, Math.trunc(Number(runRows[0]?.run_count ?? 0)));
  const tokens = Math.max(0, Math.trunc(Number(tokenRows[0]?.total_tokens ?? 0)));

  return {
    runs,
    tokens,
    dayStartAt: dayStartIso,
  };
});

/**
 * Single dynamic check for why a bot's triggers are blocked (global Bots switch,
 * paused bot, unsupported model provider, or daily run/token limits).
 */
export const resolveBotTriggerBlock = Effect.fn("BotUsage.resolveTriggerBlock")(function* (input: {
  readonly settings: ServerSettings | undefined;
  readonly projectId: ProjectId;
  readonly modelSelection?: ModelSelection | null | undefined;
  readonly sql?: SqlClient.SqlClient | undefined;
  readonly now: DateTime.DateTime;
  readonly resolveBotGate?: BotGateResolver | undefined;
}): Effect.fn.Return<BotTriggerBlock | undefined, never> {
  const { settings, projectId } = input;
  if (!isBotProject(settings, projectId)) return undefined;
  if (settings?.botsEnabled === false) {
    return { reason: BOTS_DISABLED_REASON, reasonCode: "bots_disabled", allowManualRun: false };
  }
  if (isBotPaused(settings, projectId)) {
    return { reason: BOT_PAUSED_REASON, reasonCode: "paused", allowManualRun: false };
  }

  const botProfile = settings?.projectSettingsOverrides[projectId]?.bot;
  const approvals = resolveBotApprovalsMode(botProfile);
  const effectiveModel =
    input.modelSelection ?? settings?.projectSettingsOverrides[projectId]?.defaultModelSelection;
  if (effectiveModel !== undefined && effectiveModel !== null && input.resolveBotGate) {
    const capability = yield* input.resolveBotGate(effectiveModel.instanceId);
    if (
      capability?.status === "unsupported" &&
      (capability.reasonCode === "provider_unavailable" || approvals !== "provider")
    ) {
      return {
        reason: botGateUnsupportedFallbackReason(capability.reasonCode),
        reasonCode: capability.reasonCode,
        allowManualRun: false,
      };
    }
  }

  const limits = resolveBotLimits(botProfile);
  if (limits.mode === "none" || input.sql === undefined) return undefined;

  const usage = yield* queryBotDailyUsage(input.sql, projectId, input.now);
  if (usage.runs >= limits.runsPerDay) {
    return {
      reason: BOT_DAILY_RUN_LIMIT_REASON,
      reasonCode: "daily_run_limit",
      allowManualRun: true,
    };
  }
  if (limits.mode === "runs_and_tokens" && usage.tokens >= limits.tokensPerDay) {
    return {
      reason: BOT_DAILY_TOKEN_LIMIT_REASON,
      reasonCode: "daily_token_limit",
      allowManualRun: true,
    };
  }
  return undefined;
});
