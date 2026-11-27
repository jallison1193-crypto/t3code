import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  BOT_DAILY_RUN_LIMIT_REASON,
  BOT_DAILY_TOKEN_LIMIT_REASON,
  BOT_PAUSED_REASON,
  BOTS_DISABLED_REASON,
  botGateUnsupportedFallbackReason,
  BotProfile,
  DEFAULT_BOT_LIMITS,
  ProjectId,
  ProviderInstanceId,
  resolveBotLimits,
  ScheduledTaskId,
  ThreadId,
  type Project,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotService from "./BotService.ts";
import { localDayStartUtc, resolveBotTriggerBlock } from "./botUsage.ts";

const EPOCH_ISO = "2026-10-01T12:00:00.000Z";
const decodeBotProfile = Schema.decodeUnknownSync(BotProfile);

const makeScheduledTask = (id: string, projectId: ProjectId): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: `Task ${id}`,
  prompt: "Check status",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: EPOCH_ISO,
  updatedAt: EPOCH_ISO,
  nextRunAt: EPOCH_ISO,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

const makeHarness = Effect.fn("BotServiceTest.makeHarness")(function* (initial?: {
  readonly botsEnabled?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-service-test-" });
  const projectsMap = new Map<ProjectId, Project>();
  const tasksMap = new Map<ScheduledTaskId, ScheduledTask>();
  const deletedProjectIds: ProjectId[] = [];
  const deletedTaskIds: ScheduledTaskId[] = [];
  const upsertedTaskInputs: ScheduledTaskUpsertInput[] = [];
  const launches: ThreadLaunchService.ThreadLaunchInput[] = [];

  const ordinaryProjectId = ProjectId.make("project:ordinary");
  projectsMap.set(ordinaryProjectId, {
    id: ordinaryProjectId,
    title: "Ordinary Project",
    workspaceRoot: path.join(tempRoot, "ordinary"),
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    projectIcon: null,
    scripts: [],
    trackedFolders: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: EPOCH_ISO,
    updatedAt: EPOCH_ISO,
    deletedAt: null,
  });

  const serverSettingsLayer = ServerSettings.layerTest({
    botsEnabled: initial?.botsEnabled ?? true,
  });

  const deps = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    serverSettingsLayer,
    NodeCrypto.layer,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          const threadId = ThreadId.make(`thread:run-${launches.length}`);
          return {
            threadId,
            projection: idleThreadProjection(liveThreadShell(threadId)),
            resumed: false,
          };
        }),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: path.join(tempRoot, "projects"),
      createBotFolder: ({ name }) =>
        Effect.gen(function* () {
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "bot";
          const dir = path.join(tempRoot, "bots", `${slug}-${projectsMap.size + 1}`);
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
          return { workspaceRoot: dir };
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.sync(() => ({
        projects: [...projectsMap.values()],
        updatedAt: EPOCH_ISO,
      })),
      getById: (projectId) => Effect.sync(() => Option.fromUndefinedOr(projectsMap.get(projectId))),
      create: (input) =>
        Effect.sync(() => {
          const project: Project = {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            projectIcon: null,
            scripts: [],
            trackedFolders: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: EPOCH_ISO,
            updatedAt: EPOCH_ISO,
            deletedAt: null,
          };
          projectsMap.set(project.id, project);
          return project;
        }),
      update: (input) =>
        Effect.sync(() => {
          const current = projectsMap.get(input.projectId)!;
          const next: Project = {
            ...current,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
          };
          projectsMap.set(input.projectId, next);
          return next;
        }),
      delete: (input) =>
        Effect.sync(() => {
          const current = projectsMap.get(input.projectId)!;
          deletedProjectIds.push(input.projectId);
          projectsMap.delete(input.projectId);
          return { ...current, deletedAt: EPOCH_ISO };
        }),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () =>
        Effect.sync(() => ({
          tasks: [...tasksMap.values()],
          timeZone: "UTC",
        })),
      upsert: (input) =>
        Effect.sync(() => {
          upsertedTaskInputs.push(input);
          const id = input.id ?? ScheduledTaskId.make(`task:${tasksMap.size + 1}`);
          const existing = tasksMap.get(id);
          const base = existing ?? makeScheduledTask(id, input.projectId);
          const updated: ScheduledTask = {
            ...base,
            id,
            title: input.title,
            prompt: input.prompt,
            enabled: input.enabled,
            projectId: input.projectId,
            threadId: input.threadId ?? base.threadId,
            ...(input.threadMode === undefined ? {} : { threadMode: input.threadMode }),
            workspaceStrategy: input.workspaceStrategy,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
          };
          tasksMap.set(id, updated);
          return { task: updated };
        }),
      delete: ({ id }) =>
        Effect.sync(() => {
          deletedTaskIds.push(id);
          tasksMap.delete(id);
          return { id };
        }),
    }),
  );

  const layer = BotService.layer.pipe(Layer.provideMerge(deps));
  const ctx = yield* Layer.build(layer);
  const service = yield* BotService.BotService.pipe(Effect.provide(ctx));
  const settings = yield* ServerSettings.ServerSettingsService.pipe(Effect.provide(ctx));
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(ctx));

  return {
    service,
    settings,
    sql,
    ordinaryProjectId,
    projectsMap,
    tasksMap,
    deletedProjectIds,
    deletedTaskIds,
    upsertedTaskInputs,
    launches,
  };
});

describe("BotService", () => {
  it.effect(
    "creates, lists, updates, pauses, checks triggerBlock, and deletes a bot with its tasks",
    () =>
      Effect.gen(function* () {
        const {
          service,
          settings,
          ordinaryProjectId,
          tasksMap,
          deletedProjectIds,
          deletedTaskIds,
        } = yield* makeHarness();

        const model = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        };
        const created = yield* service.create({
          name: "PR Digest",
          goal: "Summarize open pull requests every morning.",
          modelSelection: model,
        });

        expect(created.name).toBe("PR Digest");
        expect(created.goal).toBe("Summarize open pull requests every morning.");
        expect(created.modelSelection).toEqual(model);
        expect(created.paused).toBe(false);

        const savedSettings = yield* settings.getSettings;
        expect(savedSettings.projectSettingsOverrides[created.projectId]).toEqual({
          bot: {},
          projectInstructions: "Summarize open pull requests every morning.",
          defaultModelSelection: model,
        });

        // list includes bots and excludes ordinary projects.
        const listed = yield* service.list();
        expect(listed.map((b) => b.projectId)).toEqual([created.projectId]);
        expect(yield* service.get(created.projectId)).toEqual(created);
        const notABot = yield* service.get(ordinaryProjectId).pipe(Effect.flip);
        expect(notABot.reason).toBe("not_a_bot");

        // Update name, goal, clear model, and pause.
        const updated = yield* service.update({
          projectId: created.projectId,
          name: "Daily PR Digest",
          goal: "Summarize high-priority PRs.",
          modelSelection: null,
          paused: true,
        });
        expect(updated.name).toBe("Daily PR Digest");
        expect(updated.goal).toBe("Summarize high-priority PRs.");
        expect(updated.modelSelection).toBeNull();
        expect(updated.paused).toBe(true);

        expect(yield* service.triggerBlock(created.projectId)).toBe(BOT_PAUSED_REASON);
        expect(yield* service.triggerBlock(ordinaryProjectId)).toBeUndefined();

        // Turning bots off overrides paused reason and blocks mutations.
        yield* settings.updateSettings({ botsEnabled: false });
        expect(yield* service.triggerBlock(created.projectId)).toBe(BOTS_DISABLED_REASON);
        const disabledErr = yield* service.create({ name: "Blocked", goal: "" }).pipe(Effect.flip);
        expect(disabledErr.reason).toBe("bots_disabled");
        expect(disabledErr.message).toBe(BOTS_DISABLED_REASON);

        // Re-enable and unpause.
        yield* settings.updateSettings({ botsEnabled: true });
        const resumed = yield* service.update({ projectId: created.projectId, paused: false });
        expect(resumed.paused).toBe(false);
        expect(yield* service.triggerBlock(created.projectId)).toBeUndefined();

        // Delete removes bot's scheduled tasks and leaves ordinary tasks intact.
        const botTask = makeScheduledTask("task:bot", created.projectId);
        const ordinaryTask = makeScheduledTask("task:ordinary", ordinaryProjectId);
        tasksMap.set(botTask.id, botTask);
        tasksMap.set(ordinaryTask.id, ordinaryTask);

        const deleted = yield* service.delete(created.projectId);
        expect(deleted).toEqual({
          projectId: created.projectId,
          deletedScheduledTaskIds: [botTask.id],
        });
        expect(deletedTaskIds).toEqual([botTask.id]);
        expect(tasksMap.has(ordinaryTask.id)).toBe(true);
        expect(deletedProjectIds).toEqual([created.projectId]);
        expect(yield* service.list()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "decodes legacy BotProfile without limits, updates limits without losing paused state, and computes daily usage & limit blocks",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-01T15:00:00.000Z"));
        const legacy = decodeBotProfile({});
        expect(legacy.limits).toBeUndefined();
        expect(resolveBotLimits(legacy)).toEqual(DEFAULT_BOT_LIMITS);

        const withLimits = decodeBotProfile({
          paused: true,
          limits: { mode: "runs_only", runsPerDay: 5 },
        });
        expect(resolveBotLimits(withLimits)).toEqual({
          mode: "runs_only",
          runsPerDay: 5,
          tokensPerDay: DEFAULT_BOT_LIMITS.tokensPerDay,
        });

        const { service, settings, sql, ordinaryProjectId, launches } = yield* makeHarness();
        const created = yield* service.create({
          name: "Daily Bot",
          goal: "Check metrics",
        });
        expect(created.limits).toEqual(DEFAULT_BOT_LIMITS);

        // Updating limits preserves paused, and toggling paused preserves limits.
        yield* service.update({
          projectId: created.projectId,
          limits: { mode: "runs_and_tokens", runsPerDay: 2, tokensPerDay: 1000 },
        });
        const pausedBot = yield* service.update({
          projectId: created.projectId,
          paused: true,
        });
        expect(pausedBot.paused).toBe(true);
        expect(pausedBot.limits).toEqual({
          mode: "runs_and_tokens",
          runsPerDay: 2,
          tokensPerDay: 1000,
        });
        yield* service.update({ projectId: created.projectId, paused: false });

        const now = yield* DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
        const dayStart = localDayStartUtc(now);
        const todayIso = DateTime.formatIso(DateTime.add(dayStart, { hours: 1 }));
        const yesterdayIso = DateTime.formatIso(DateTime.subtract(dayStart, { hours: 1 }));

        // Seed today's bot thread, yesterday's bot thread, and an ordinary project thread.
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
          ) VALUES
            ('thread:today', ${created.projectId}, 'Today', 'codex', 'approval-required', 'default', NULL, ${todayIso}, ${todayIso}, NULL, NULL, '{}'),
            ('thread:yesterday', ${created.projectId}, 'Yesterday', 'codex', 'approval-required', 'default', NULL, ${yesterdayIso}, ${yesterdayIso}, NULL, NULL, '{}'),
            ('thread:other', ${ordinaryProjectId}, 'Other', 'codex', 'full-access', 'default', NULL, ${todayIso}, ${todayIso}, NULL, NULL, '{}')
        `;

        // Insert 1 scheduled run today, 1 manual run today (excluded from runs), 1 yesterday (excluded), 1 other project (excluded).
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES
            ('scheduled-task-message:t1:1:scheduled', 'thread:today', 'run:1', 'node:1', 'user', 0, ${todayIso}, ${todayIso}, '{"scheduledTaskId":"task:1"}'),
            ('scheduled-task-message:t1:2:manual', 'thread:today', 'run:2', 'node:2', 'user', 0, ${todayIso}, ${todayIso}, '{"scheduledTaskId":"task:1"}'),
            ('scheduled-task-message:t1:0:scheduled', 'thread:yesterday', 'run:0', 'node:0', 'user', 0, ${yesterdayIso}, ${yesterdayIso}, '{"scheduledTaskId":"task:1"}'),
            ('scheduled-task-message:t2:1:scheduled', 'thread:other', 'run:3', 'node:3', 'user', 0, ${todayIso}, ${todayIso}, '{"scheduledTaskId":"task:2"}')
        `;

        // Insert 600 tokens today for bot, 5000 yesterday, 9000 other project.
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns (
            provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json
          ) VALUES
            ('pt:today-1', 'thread:today', 'pth:1', 'node:1', 'att:1', 1, 'completed', ${todayIso}, ${todayIso}, '{"turnTokenUsage":{"inputTokens":400,"outputTokens":200}}'),
            ('pt:yesterday', 'thread:yesterday', 'pth:0', 'node:0', 'att:0', 1, 'completed', ${yesterdayIso}, ${yesterdayIso}, '{"turnTokenUsage":{"inputTokens":4000,"outputTokens":1000}}'),
            ('pt:other', 'thread:other', 'pth:2', 'node:3', 'att:3', 1, 'completed', ${todayIso}, ${todayIso}, '{"turnTokenUsage":{"inputTokens":8000,"outputTokens":1000}}')
        `;

        const usage1 = yield* service.getUsage(created.projectId);
        expect(usage1.usage.runs).toBe(1);
        expect(usage1.usage.tokens).toBe(600);
        expect(yield* service.triggerBlock(created.projectId)).toBeUndefined();

        // Hit token limit (600 + 500 >= 1000).
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns (
            provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json
          ) VALUES
            ('pt:today-2', 'thread:today', 'pth:1', 'node:2', 'att:2', 2, 'completed', ${todayIso}, ${todayIso}, '{"tokenUsage":{"inputTokens":300,"outputTokens":200,"usedTokens":500}}')
        `;
        expect(yield* service.triggerBlock(created.projectId)).toBe(BOT_DAILY_TOKEN_LIMIT_REASON);

        // Switching to runs_only ignores token limit while still enforcing run limit.
        yield* service.update({
          projectId: created.projectId,
          limits: { mode: "runs_only", runsPerDay: 2 },
        });
        expect(yield* service.triggerBlock(created.projectId)).toBeUndefined();

        // Add a webhook run today -> hits runsPerDay (2).
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES
            ('scheduled-task-message:t1:webhook:d1', 'thread:today', 'run:4', 'node:4', 'user', 0, ${todayIso}, ${todayIso}, '{"scheduledTaskId":"task:1"}')
        `;
        expect(yield* service.triggerBlock(created.projectId)).toBe(BOT_DAILY_RUN_LIMIT_REASON);

        // Run now on the bot is refused at the limit and says why.
        const fallbackModelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        };
        const runInput = {
          projectId: created.projectId,
          prompt: "Do your goal now.",
          fallbackModelSelection,
        };
        expect((yield* service.getUsage(created.projectId)).blockedByPolicy).toBe(
          BOT_DAILY_RUN_LIMIT_REASON,
        );
        expect(yield* Effect.flip(service.run(runInput))).toMatchObject({
          reason: "blocked",
          detail: BOT_DAILY_RUN_LIMIT_REASON,
        });
        expect(launches).toEqual([]);

        // Switching to none lifts all usage limits.
        yield* service.update({
          projectId: created.projectId,
          limits: { mode: "none" },
        });
        expect(yield* service.triggerBlock(created.projectId)).toBeUndefined();

        // A run starts its own thread in the bot's project, held by the approval gate.
        expect(yield* service.run(runInput)).toEqual({
          projectId: created.projectId,
          threadId: ThreadId.make("thread:run-1"),
        });
        expect(launches[0]).toMatchObject({
          projectId: created.projectId,
          title: "Daily Bot",
          modelSelection: fallbackModelSelection,
          runtimeMode: "approval-required",
          initialMessage: { text: "Do your goal now." },
        });

        // The bot's saved model wins over the client's fallback; pause and the off switch refuse.
        const savedModel = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
        };
        yield* service.update({ projectId: created.projectId, modelSelection: savedModel });
        yield* service.run(runInput);
        expect(launches[1]?.modelSelection).toEqual(savedModel);
        yield* service.update({ projectId: created.projectId, paused: true });
        expect(yield* Effect.flip(service.run(runInput))).toMatchObject({
          detail: BOT_PAUSED_REASON,
        });
        yield* service.update({ projectId: created.projectId, paused: false });
        yield* settings.updateSettings({ botsEnabled: false });
        expect(yield* Effect.flip(service.run(runInput))).toMatchObject({
          detail: BOTS_DISABLED_REASON,
        });
        yield* settings.updateSettings({ botsEnabled: true });
        expect(launches).toHaveLength(2);

        // Unsupported provider blocks triggers before limits with structured reasonCode.
        const currentSettings = yield* settings.getSettings;
        const unsupportedBlock = yield* resolveBotTriggerBlock({
          settings: currentSettings,
          projectId: created.projectId,
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "cursor-fast" },
          sql,
          now,
          resolveBotGate: () =>
            Effect.succeed({ status: "unsupported", reasonCode: "no_approval_callback" }),
        });
        expect(unsupportedBlock).toEqual({
          reason: botGateUnsupportedFallbackReason("no_approval_callback"),
          reasonCode: "no_approval_callback",
          allowManualRun: false,
        });

        // Round-trips per-bot approvals mode and lifts only the provider-support block.
        expect(created.approvals).toBe("t3_gate");
        const cursorModel = {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "cursor-fast",
        };
        const updatedToProvider = yield* service.update({
          projectId: created.projectId,
          modelSelection: cursorModel,
          approvals: "provider",
        });
        expect(updatedToProvider.approvals).toBe("provider");
        expect((yield* service.get(created.projectId)).approvals).toBe("provider");

        const providerSettings = yield* settings.getSettings;
        const unblockedWithProvider = yield* resolveBotTriggerBlock({
          settings: providerSettings,
          projectId: created.projectId,
          modelSelection: cursorModel,
          sql,
          now,
          resolveBotGate: () =>
            Effect.succeed({ status: "unsupported", reasonCode: "no_approval_callback" }),
        });
        expect(unblockedWithProvider).toBeUndefined();

        // Missing provider instance still fails closed even in provider approvals mode.
        const missingWithProvider = yield* resolveBotTriggerBlock({
          settings: providerSettings,
          projectId: created.projectId,
          modelSelection: cursorModel,
          sql,
          now,
          resolveBotGate: () =>
            Effect.succeed({ status: "unsupported", reasonCode: "provider_unavailable" }),
        });
        expect(missingWithProvider).toEqual({
          reason: botGateUnsupportedFallbackReason("provider_unavailable"),
          reasonCode: "provider_unavailable",
          allowManualRun: false,
        });

        // Switching back to t3_gate keeps Cursor stored and blocks running until a supported model is picked.
        const switchedBack = yield* service.update({
          projectId: created.projectId,
          approvals: "t3_gate",
        });
        expect(switchedBack.approvals).toBe("t3_gate");
        expect(switchedBack.modelSelection).toEqual(cursorModel);
        const reblocked = yield* resolveBotTriggerBlock({
          settings: yield* settings.getSettings,
          projectId: created.projectId,
          modelSelection: cursorModel,
          sql,
          now,
          resolveBotGate: () =>
            Effect.succeed({ status: "unsupported", reasonCode: "no_approval_callback" }),
        });
        expect(reblocked).toEqual({
          reason: botGateUnsupportedFallbackReason("no_approval_callback"),
          reasonCode: "no_approval_callback",
          allowManualRun: false,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "updates every trigger of a bot when the bot's model changes without touching other projects",
    () =>
      Effect.gen(function* () {
        const { service, settings, ordinaryProjectId, tasksMap, upsertedTaskInputs } =
          yield* makeHarness();

        const codexModel = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        };
        const haikuModel = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
          options: [{ id: "reasoning", value: "medium" }],
        };
        const envDefaultModel = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        };

        const bot = yield* service.create({
          name: "Inbox Triage",
          goal: "Triage incoming notifications.",
          modelSelection: codexModel,
        });
        const otherBot = yield* service.create({
          name: "Other Bot",
          goal: "Keep own model.",
          modelSelection: codexModel,
        });

        const intervalTrigger = makeScheduledTask("task:bot-interval", bot.projectId);
        const webhookTrigger: ScheduledTask = {
          ...makeScheduledTask("task:bot-webhook", bot.projectId),
          schedule: { type: "webhook", signature: null },
          webhook: { path: "/api/hooks/task:bot-webhook/token", url: null, hasSecret: false },
        };
        const otherBotTrigger = makeScheduledTask("task:other-bot", otherBot.projectId);
        const ordinaryTrigger = makeScheduledTask("task:ordinary", ordinaryProjectId);
        tasksMap.set(intervalTrigger.id, intervalTrigger);
        tasksMap.set(webhookTrigger.id, webhookTrigger);
        tasksMap.set(otherBotTrigger.id, otherBotTrigger);
        tasksMap.set(ordinaryTrigger.id, ordinaryTrigger);

        // Goal-only update leaves triggers untouched.
        yield* service.update({ projectId: bot.projectId, goal: "Updated goal" });
        expect(upsertedTaskInputs).toEqual([]);

        // Changing the bot's model updates both of its triggers to the new model.
        yield* service.update({ projectId: bot.projectId, modelSelection: haikuModel });
        expect(upsertedTaskInputs.map((entry) => entry.id)).toEqual([
          intervalTrigger.id,
          webhookTrigger.id,
        ]);
        expect(tasksMap.get(intervalTrigger.id)?.modelSelection).toEqual(haikuModel);
        expect(tasksMap.get(webhookTrigger.id)?.modelSelection).toEqual(haikuModel);
        expect(tasksMap.get(otherBotTrigger.id)?.modelSelection).toEqual(codexModel);
        expect(tasksMap.get(ordinaryTrigger.id)?.modelSelection).toEqual(codexModel);

        // Clearing the bot's model falls back to the environment default when configured.
        yield* settings.updateSettings({ defaultModelSelection: envDefaultModel });
        yield* service.update({ projectId: bot.projectId, modelSelection: null });
        expect(tasksMap.get(intervalTrigger.id)?.modelSelection).toEqual(envDefaultModel);
        expect(tasksMap.get(webhookTrigger.id)?.modelSelection).toEqual(envDefaultModel);
        expect(tasksMap.get(otherBotTrigger.id)?.modelSelection).toEqual(codexModel);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "applies botDefaults to new bots without limits or supported model, keeps explicit values, and leaves existing bots unchanged",
    () =>
      Effect.gen(function* () {
        const { service, settings } = yield* makeHarness();

        const defaultModel = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
          options: [{ id: "reasoning", value: "medium" }],
        };
        const explicitModel = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        };
        const defaultLimits = {
          mode: "runs_and_tokens" as const,
          runsPerDay: 12,
          tokensPerDay: 500_000,
        };
        const explicitLimits = {
          mode: "runs_only" as const,
          runsPerDay: 3,
        };

        yield* settings.updateSettings({
          botDefaults: {
            modelSelection: defaultModel,
            limits: defaultLimits,
          },
        });

        const inherited = yield* service.create({
          name: "Inherited Defaults",
          goal: "Check status",
        });
        expect(inherited.modelSelection).toEqual(defaultModel);
        expect(inherited.limits).toEqual(defaultLimits);

        const explicit = yield* service.create({
          name: "Explicit Values",
          goal: "Check status",
          modelSelection: explicitModel,
          limits: explicitLimits,
        });
        expect(explicit.modelSelection).toEqual(explicitModel);
        expect(explicit.limits).toEqual({
          mode: "runs_only",
          runsPerDay: 3,
          tokensPerDay: DEFAULT_BOT_LIMITS.tokensPerDay,
        });

        // Changing defaults later leaves existing bots unchanged and replaces options cleanly.
        const updatedModel = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        };
        yield* settings.updateSettings({
          botDefaults: {
            modelSelection: updatedModel,
            limits: { mode: "none" },
          },
        });
        expect((yield* service.get(inherited.projectId)).modelSelection).toEqual(defaultModel);
        expect((yield* service.get(inherited.projectId)).limits).toEqual(defaultLimits);

        const afterUpdate = yield* service.create({ name: "After Update" });
        expect(afterUpdate.modelSelection).toEqual(updatedModel);
        expect(afterUpdate.limits).toEqual({
          mode: "none",
          runsPerDay: DEFAULT_BOT_LIMITS.runsPerDay,
          tokensPerDay: DEFAULT_BOT_LIMITS.tokensPerDay,
        });

        // Unsupported default model falls back to no explicit model while still applying limits.
        yield* settings.updateSettings({
          botDefaults: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "cursor-fast",
            },
            limits: { mode: "runs_only", runsPerDay: 7 },
          },
        });
        const unsupportedDefault = yield* service.create({ name: "Unsupported Default" });
        expect(unsupportedDefault.modelSelection).toBeNull();
        expect(unsupportedDefault.limits).toEqual({
          mode: "runs_only",
          runsPerDay: 7,
          tokensPerDay: DEFAULT_BOT_LIMITS.tokensPerDay,
        });

        // Resetting fields with null omits botDefaults cleanly.
        yield* settings.updateSettings({ botDefaults: { modelSelection: null } });
        expect((yield* settings.getSettings).botDefaults).toEqual({
          limits: { mode: "runs_only", runsPerDay: 7 },
        });
        yield* settings.updateSettings({ botDefaults: { limits: null } });
        expect((yield* settings.getSettings).botDefaults).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
