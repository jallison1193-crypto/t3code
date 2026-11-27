import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  BOT_DAILY_RUN_LIMIT_REASON,
  BOT_DAILY_TOKEN_LIMIT_REASON,
  BOT_PAUSED_REASON,
  BOTS_DISABLED_REASON,
  botGateUnsupportedFallbackReason,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const BOT_PROJECT = ProjectId.make("project:bot-1");
const ORDINARY_PROJECT = ProjectId.make("project:ordinary-1");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const BASE_TIME = Date.parse("2026-10-01T12:00:00.000Z");

const makeLiveTestSettings = Effect.fn("ScheduledTaskServiceBotsTest.makeSettings")(function* (
  initial: ServerSettingsValue,
) {
  const ref = yield* Ref.make(initial);
  const pubsub = yield* PubSub.unbounded<ServerSettingsValue>();
  const update = (patch: ServerSettingsPatch) =>
    Ref.updateAndGet(ref, (current) => applyServerSettingsPatch(current, patch)).pipe(
      Effect.tap((next) => PubSub.publish(pubsub, next)),
    );
  const service = {
    managedPolicy: undefined,
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(ref),
    updateSettings: update,
    setThreadSectionMembership: () => Effect.void,
    updateProviderInstance: () => Ref.get(ref),
    withSettingsSnapshot: (use) => Ref.get(ref).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(pubsub),
    subscribeChanges: Effect.succeed(Stream.fromPubSub(pubsub)),
  } satisfies ServerSettings.ServerSettingsService["Service"];
  return { service, update };
});

const makeHarness = Effect.fn("ScheduledTaskServiceBotsTest.makeHarness")(function* (
  initialSettings: ServerSettingsValue,
  options?: {
    readonly driversByInstance?: Readonly<Record<string, ProviderDriverKind>>;
  },
) {
  yield* TestClock.setTime(BASE_TIME);
  const { service: settingsService, update: updateSettings } =
    yield* makeLiveTestSettings(initialSettings);
  const launchedProjects = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
  let nextThreadSeq = 1;

  const sqliteLayer = SqlitePersistence.layerMemory;
  const sqlContext = yield* Layer.build(sqliteLayer);
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(sqlContext));

  const driversByInstance: Readonly<Record<string, ProviderDriverKind>> =
    options?.driversByInstance ?? {
      codex: ProviderDriverKind.make("codex"),
      claude: ProviderDriverKind.make("claudeAgent"),
      cursor: ProviderDriverKind.make("cursor"),
    };

  const layer = ScheduledTaskService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeedContext(sqlContext),
        ManagedPolicy.layerTest(),
        Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (instanceId) => {
            const driverKind = driversByInstance[instanceId];
            if (driverKind === undefined) return Effect.undefined;
            return Effect.gen(function* () {
              const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
                Effect.provide(
                  Layer.mock(ProviderAdapter.ProviderAdapterV2)({
                    instanceId,
                    driver: driverKind,
                  }),
                ),
              );
              const botGate = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === driverKind)
                ?.metadata.botGate;
              const snapshotValue: ServerProvider = {
                instanceId,
                driver: driverKind,
                enabled: true,
                installed: true,
                version: null,
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: "2026-10-01T12:00:00.000Z",
                models: [],
                slashCommands: [],
                skills: [],
                ...(botGate === undefined ? {} : { botGate }),
              };
              const instance: ProviderInstance = {
                instanceId,
                driverKind,
                continuationIdentity: { driverKind, continuationKey: instanceId },
                displayName: undefined,
                enabled: true,
                snapshot: {
                  resolveMaintenance: () =>
                    Effect.succeed({
                      provider: driverKind,
                      packageName: null,
                      update: null,
                    }),
                  getSnapshot: Effect.succeed(snapshotValue),
                  refresh: Effect.succeed(snapshotValue),
                  streamChanges: Stream.empty,
                  applyUsageLimits: () => Effect.void,
                },
                orchestrationAdapter: adapter,
                textGeneration: {
                  generateTranscriptionPostProcessing: () => Effect.die("unused"),
                  generateCommitMessage: () => Effect.die("unused"),
                  generatePrContent: () => Effect.die("unused"),
                  generateBranchName: () => Effect.die("unused"),
                  generateThreadTitle: () => Effect.die("unused"),
                  generateReviewGuide: () => Effect.die("unused"),
                },
              };
              return instance;
            });
          },
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          isNonGitProject: () => Effect.succeed(true),
          launch: (input) =>
            Effect.gen(function* () {
              const threadId = ThreadId.make(`thread:run-${nextThreadSeq++}`);
              const createdAt = DateTime.formatIso(yield* DateTime.now);
              yield* sql`
                INSERT INTO orchestration_v2_projection_threads (
                  thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                  active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
                ) VALUES (
                  ${threadId}, ${input.projectId}, ${input.title}, 'codex', ${input.runtimeMode},
                  ${input.interactionMode}, NULL, ${createdAt}, ${createdAt}, NULL, NULL, '{}'
                )
              `;
              if (input.initialMessage !== undefined) {
                const payload = JSON.stringify(
                  input.initialMessage.scheduledTaskId === undefined
                    ? {}
                    : { scheduledTaskId: input.initialMessage.scheduledTaskId },
                );
                yield* sql`
                  INSERT INTO orchestration_v2_projection_messages (
                    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
                  ) VALUES (
                    ${input.initialMessage.messageId}, ${threadId}, NULL, NULL, 'user', 0,
                    ${createdAt}, ${createdAt}, ${payload}
                  )
                `;
              }
              yield* Ref.update(launchedProjects, (list) => [...list, input.projectId]);
              return {
                threadId,
                projection: idleThreadProjection(liveThreadShell(threadId)),
                resumed: false,
              };
            }).pipe(Effect.orDie),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        NodeCrypto.layer,
        Scheduler.layer,
      ),
    ),
  );

  const ctx = yield* Layer.build(layer);
  const tasks = yield* ScheduledTaskService.ScheduledTaskService.pipe(Effect.provide(ctx));
  return { tasks, updateSettings, launchedProjects, sql };
});

const intervalTaskInput = (projectId: ProjectId, title: string): ScheduledTaskUpsertInput => ({
  title,
  prompt: `Run ${title}`,
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
});

describe("ScheduledTaskService bot trigger blocking", () => {
  it.effect(
    "skips blocked bot ticks, advances nextRunAt, refuses run-now and webhooks, fires no backlog on unblock, and leaves ordinary tasks unaffected",
    () =>
      Effect.gen(function* () {
        const { tasks, updateSettings, launchedProjects } = yield* makeHarness({
          ...DEFAULT_SERVER_SETTINGS,
          botsEnabled: true,
          projectSettingsOverrides: {
            [BOT_PROJECT]: { bot: { paused: true } },
          },
        });

        const { task: botTask } = yield* tasks.upsert(intervalTaskInput(BOT_PROJECT, "Bot check"));
        const { task: ordinaryTask } = yield* tasks.upsert(
          intervalTaskInput(ORDINARY_PROJECT, "Ordinary check"),
        );
        const { task: botWebhook } = yield* tasks.upsert({
          title: "Bot hook",
          prompt: "Handle hook",
          enabled: true,
          schedule: { type: "webhook" },
          projectId: BOT_PROJECT,
          threadMode: "new_thread",
          workspaceStrategy: { type: "root" },
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
        });

        // Paused bot reports blockedByPolicy; ordinary task does not.
        expect(botTask.blockedByPolicy).toBe(BOT_PAUSED_REASON);
        expect(botWebhook.blockedByPolicy).toBe(BOT_PAUSED_REASON);
        expect(ordinaryTask.blockedByPolicy).toBeUndefined();

        // runNow is refused while paused.
        const pausedRunNow = yield* tasks.runNow({ id: botTask.id }).pipe(Effect.flip);
        expect(pausedRunNow.message).toBe(BOT_PAUSED_REASON);

        // Webhook delivery is refused while paused.
        const token = botWebhook.webhook?.path.split("/").at(-1) ?? "";
        const pausedWebhookResult = yield* tasks.triggerWebhook({
          hookId: botWebhook.id,
          token,
          method: "POST",
          path: `/api/hooks/${botWebhook.id}`,
          query: "",
          headers: {},
          body: new TextEncoder().encode("{}"),
          bodyText: "{}",
        });
        expect(pausedWebhookResult._tag).toBe("blocked_by_policy");

        // Advance past the first interval: ordinary task runs, bot task is skipped and advances nextRunAt.
        const initialBotNextRunAt = botTask.nextRunAt;
        yield* TestClock.adjust("65 seconds");
        const launchedAfterFirstTick = yield* Ref.get(launchedProjects);
        expect(launchedAfterFirstTick).toEqual([ORDINARY_PROJECT]);

        const listedWhilePaused = yield* tasks.list();
        const pausedBotAfterTick = listedWhilePaused.tasks.find((t) => t.id === botTask.id)!;
        expect(pausedBotAfterTick.enabled).toBe(true);
        expect(pausedBotAfterTick.lastRunStatus).toBe("never");
        expect(pausedBotAfterTick.runCount).toBe(0);
        expect(pausedBotAfterTick.nextRunAt).not.toBe(initialBotNextRunAt);
        assert.isTrue(
          Date.parse(pausedBotAfterTick.nextRunAt!) > BASE_TIME + 65_000,
          "bot task nextRunAt should advance past current time",
        );

        // Switch Bots globally off: reason updates dynamically.
        yield* updateSettings({ botsEnabled: false });
        const listedOff = yield* tasks.list();
        const offBot = listedOff.tasks.find((t) => t.id === botTask.id)!;
        expect(offBot.blockedByPolicy).toBe(BOTS_DISABLED_REASON);
        const offRunNow = yield* tasks.runNow({ id: botTask.id }).pipe(Effect.flip);
        expect(offRunNow.message).toBe(BOTS_DISABLED_REASON);
        const offWebhookResult = yield* tasks.triggerWebhook({
          hookId: botWebhook.id,
          token,
          method: "POST",
          path: `/api/hooks/${botWebhook.id}`,
          query: "",
          headers: {},
          body: new TextEncoder().encode("{}"),
          bodyText: "{}",
        });
        expect(offWebhookResult._tag).toBe("blocked_by_policy");

        // Advance across two more intervals while Bots are off; still zero bot launches.
        yield* TestClock.adjust("130 seconds");
        const launchesWhileOff = yield* Ref.get(launchedProjects);
        expect(launchesWhileOff.filter((id) => id === BOT_PROJECT)).toEqual([]);

        // Re-enable Bots and resume the bot: turning back on must NOT fire a backlog immediately.
        yield* updateSettings({
          botsEnabled: true,
          projectSettingsOverrides: { [BOT_PROJECT]: { bot: {} } },
        });
        const listedResumed = yield* tasks.list();
        const resumedBot = listedResumed.tasks.find((t) => t.id === botTask.id)!;
        expect(resumedBot.blockedByPolicy).toBeUndefined();

        // Advance 5 seconds (before nextRunAt): still no backlog launch for the bot.
        yield* TestClock.adjust("5 seconds");
        const launchesRightAfterUnblock = yield* Ref.get(launchedProjects);
        expect(launchesRightAfterUnblock.filter((id) => id === BOT_PROJECT)).toEqual([]);

        // Once the next scheduled time arrives, the bot task runs once normally.
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const waitMs = Math.max(6_000, Date.parse(resumedBot.nextRunAt!) - nowMs + 6_000);
        yield* TestClock.adjust(`${waitMs} millis`);
        const launchesAfterNextSlot = yield* Ref.get(launchedProjects);
        expect(launchesAfterNextSlot.filter((id) => id === BOT_PROJECT)).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "enforces daily run and token limits on scheduled ticks and webhooks while allowing runNow, resets at local midnight with no backlog, and reports unsupported providers",
    () =>
      Effect.gen(function* () {
        const { tasks, updateSettings, launchedProjects, sql } = yield* makeHarness({
          ...DEFAULT_SERVER_SETTINGS,
          botsEnabled: true,
          projectSettingsOverrides: {
            [BOT_PROJECT]: {
              bot: {
                limits: { mode: "runs_and_tokens", runsPerDay: 1, tokensPerDay: 1_000 },
              },
            },
          },
        });

        const { task: botTask } = yield* tasks.upsert(intervalTaskInput(BOT_PROJECT, "Bot check"));
        const { task: botWebhook } = yield* tasks.upsert({
          title: "Bot hook",
          prompt: "Handle hook",
          enabled: true,
          schedule: { type: "webhook" },
          projectId: BOT_PROJECT,
          threadMode: "new_thread",
          workspaceStrategy: { type: "root" },
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const webhookToken = botWebhook.webhook?.path.split("/").at(-1) ?? "";

        // First scheduled tick runs and hits runsPerDay = 1.
        yield* TestClock.adjust("65 seconds");
        expect(yield* Ref.get(launchedProjects)).toEqual([BOT_PROJECT]);

        const listedAfterFirst = yield* tasks.list();
        const afterFirst = listedAfterFirst.tasks.find((t) => t.id === botTask.id)!;
        expect(afterFirst.blockedByPolicy).toBe(BOT_DAILY_RUN_LIMIT_REASON);

        // Second scheduled tick is skipped and advances nextRunAt.
        const nextBeforeSkip = afterFirst.nextRunAt;
        yield* TestClock.adjust("65 seconds");
        expect(yield* Ref.get(launchedProjects)).toEqual([BOT_PROJECT]);
        const afterSkip = (yield* tasks.list()).tasks.find((t) => t.id === botTask.id)!;
        expect(afterSkip.nextRunAt).not.toBe(nextBeforeSkip);

        // Webhook is refused while at run limit.
        const webhookAtLimit = yield* tasks.triggerWebhook({
          hookId: botWebhook.id,
          token: webhookToken,
          method: "POST",
          path: `/api/hooks/${botWebhook.id}`,
          query: "",
          headers: {},
          body: new TextEncoder().encode("{}"),
          bodyText: "{}",
        });
        expect(webhookAtLimit._tag).toBe("blocked_by_policy");

        // Manual runNow STILL WORKS when blocked only by usage limits.
        const manualResult = yield* tasks.runNow({ id: botTask.id });
        expect(manualResult.threadId).not.toBeNull();
        expect(yield* Ref.get(launchedProjects)).toHaveLength(2);

        // Raise runsPerDay above current count, then exceed tokensPerDay.
        yield* updateSettings({
          projectSettingsOverrides: {
            [BOT_PROJECT]: {
              bot: {
                limits: { mode: "runs_and_tokens", runsPerDay: 10, tokensPerDay: 1_000 },
              },
            },
          },
        });
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns (
            provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json
          ) VALUES (
            'pt:over-token-limit', 'thread:run-1', 'pth:1', 'node:1', 'att:1', 1, 'completed',
            ${nowIso}, ${nowIso}, '{"turnTokenUsage":{"inputTokens":700,"outputTokens":500}}'
          )
        `;
        const listedTokenBlocked = yield* tasks.list();
        expect(listedTokenBlocked.tasks.find((t) => t.id === botTask.id)?.blockedByPolicy).toBe(
          BOT_DAILY_TOKEN_LIMIT_REASON,
        );

        // Webhook refused at token limit; runNow still works.
        yield* TestClock.adjust("1 second");
        const webhookAtTokenLimit = yield* tasks.triggerWebhook({
          hookId: botWebhook.id,
          token: webhookToken,
          method: "POST",
          path: `/api/hooks/${botWebhook.id}`,
          query: "",
          headers: {},
          body: new TextEncoder().encode("{}"),
          bodyText: "{}",
        });
        expect(webhookAtTokenLimit._tag).toBe("blocked_by_policy");
        const manualAtTokenLimit = yield* tasks.runNow({ id: botTask.id });
        expect(manualAtTokenLimit.threadId).not.toBeNull();

        // Mode "none" never blocks.
        yield* updateSettings({
          projectSettingsOverrides: {
            [BOT_PROJECT]: { bot: { limits: { mode: "none" } } },
          },
        });
        expect(
          (yield* tasks.list()).tasks.find((t) => t.id === botTask.id)?.blockedByPolicy,
        ).toBeUndefined();

        // Re-apply run limit, then advance across local midnight without spanning 24h of scheduler ticks.
        yield* updateSettings({
          projectSettingsOverrides: {
            [BOT_PROJECT]: {
              bot: {
                limits: { mode: "runs_and_tokens", runsPerDay: 1, tokensPerDay: 1_000 },
              },
            },
          },
        });
        expect((yield* tasks.list()).tasks.find((t) => t.id === botTask.id)?.blockedByPolicy).toBe(
          BOT_DAILY_RUN_LIMIT_REASON,
        );

        // Jump the test clock to 3 minutes before the next local midnight, then step past midnight.
        yield* tasks.setEnabled({ id: botTask.id, enabled: false });
        const currentLocal = yield* DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
        const nextLocalMidnight = DateTime.toUtc(
          DateTime.add(DateTime.startOf(currentLocal, "day"), { days: 1 }),
        );
        const threeMinutesBeforeMidnight = DateTime.toEpochMillis(nextLocalMidnight) - 3 * 60_000;
        yield* TestClock.setTime(threeMinutesBeforeMidnight);

        const { task: midnightTask } = yield* tasks.upsert({
          title: "Midnight check",
          prompt: "Run after midnight",
          enabled: true,
          schedule: { type: "interval", everyMs: 120_000 },
          projectId: BOT_PROJECT,
          threadMode: "new_thread",
          workspaceStrategy: { type: "root" },
          modelSelection: MODEL,
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        expect(midnightTask.blockedByPolicy).toBe(BOT_DAILY_RUN_LIMIT_REASON);

        // Step 130 seconds (23:59:10): the 23:59:00 slot is skipped due to daily run limit, nextRunAt becomes 00:01:00.
        const launchesBeforeMidnight = (yield* Ref.get(launchedProjects)).length;
        yield* TestClock.adjust("130 seconds");
        expect((yield* Ref.get(launchedProjects)).length).toBe(launchesBeforeMidnight);

        // Step 60 seconds (00:00:10, past local midnight, before 00:01:00): block lifts on its own, zero backlog runs.
        yield* TestClock.adjust("60 seconds");
        const afterMidnight = (yield* tasks.list()).tasks.find((t) => t.id === midnightTask.id)!;
        expect(afterMidnight.blockedByPolicy).toBeUndefined();
        expect((yield* Ref.get(launchedProjects)).length).toBe(launchesBeforeMidnight);

        // Step 60 seconds (00:01:10, past the post-midnight slot): runs once on the new day.
        yield* TestClock.adjust("60 seconds");
        expect((yield* Ref.get(launchedProjects)).length).toBe(launchesBeforeMidnight + 1);

        // Unsupported provider shows in blockedByPolicy and refuses runNow & webhooks.
        const cursorReason = botGateUnsupportedFallbackReason("no_approval_callback");
        const { task: unsupportedTask } = yield* tasks.upsert({
          ...intervalTaskInput(BOT_PROJECT, "Unsupported model task"),
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "cursor-fast" },
        });
        expect(unsupportedTask.blockedByPolicy).toBe(cursorReason);
        const unsupportedRunNow = yield* tasks.runNow({ id: unsupportedTask.id }).pipe(Effect.flip);
        expect(unsupportedRunNow.message).toBe(cursorReason);
      }).pipe(Effect.scoped),
  );
});
