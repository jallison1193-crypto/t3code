import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  BOT_PAUSED_REASON,
  BOTS_DISABLED_REASON,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
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
) {
  yield* TestClock.setTime(BASE_TIME);
  const { service: settingsService, update: updateSettings } =
    yield* makeLiveTestSettings(initialSettings);
  const launchedProjects = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
  let nextThreadSeq = 1;

  const layer = ScheduledTaskService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        ManagedPolicy.layerTest(),
        Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          isNonGitProject: () => Effect.succeed(true),
          launch: (input) => {
            const threadId = ThreadId.make(`thread:run-${nextThreadSeq++}`);
            return Ref.update(launchedProjects, (list) => [...list, input.projectId]).pipe(
              Effect.as({
                threadId,
                projection: idleThreadProjection(liveThreadShell(threadId)),
                resumed: false,
              }),
            );
          },
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
  return { tasks, updateSettings, launchedProjects };
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
});
