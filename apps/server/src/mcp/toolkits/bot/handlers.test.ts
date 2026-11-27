import { describe, expect, it } from "@effect/vitest";
import {
  BotOperationError,
  BOTS_DISABLED_REASON,
  type BotRecord,
  DEFAULT_BOT_LIMITS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  resolveBotLimits,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotHandlers from "./handlers.ts";
import { BotToolkit } from "./tools.ts";

const LOCAL_ENV = EnvironmentId.make("env:local");
const CALLER_THREAD = ThreadId.make("thread:caller");
const RUN_THREAD_1 = ThreadId.make("thread:bot-run-1");
const BOT_ID = ProjectId.make("project:bot-digest");
const EPOCH = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z");

const threadScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: LOCAL_ENV,
  requestNamespace: `provider:${CALLER_THREAD}`,
  thread: {
    threadId: CALLER_THREAD,
    providerSessionId: `provider:${CALLER_THREAD}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: LOCAL_ENV,
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Test Client", access },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const makeHarness = Effect.fn("BotToolkitTest.makeHarness")(function* (initial?: {
  readonly botsEnabled?: boolean;
}) {
  const botsMap = new Map<ProjectId, BotRecord>();
  const tasks: ScheduledTask[] = [
    {
      id: ScheduledTaskId.make("task:digest-daily"),
      title: "Morning digest",
      prompt: "Summarize PRs",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      projectId: BOT_ID,
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: DateTime.formatIso(EPOCH),
      updatedAt: DateTime.formatIso(EPOCH),
      nextRunAt: DateTime.formatIso(EPOCH),
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    },
  ];
  const botRunShell = {
    ...liveThreadShell(RUN_THREAD_1, { activeRunId: null }),
    projectId: BOT_ID,
    title: "Morning digest run",
    status: "completed" as const,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };

  const settingsContext = yield* Layer.build(
    ServerSettings.layerTest({
      botsEnabled: initial?.botsEnabled ?? true,
    }),
  );
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.provide(settingsContext),
  );

  const deps = Layer.mergeAll(
    Layer.succeed(ServerSettings.ServerSettingsService, settings),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(id === CALLER_THREAD ? liveThreadShell(CALLER_THREAD) : null),
      getShellSnapshot: (opts) =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: opts?.projectId === BOT_ID ? [botRunShell] : [],
          archivedThreads: [],
        }),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks, timeZone: "UTC" }),
    }),
    Layer.mock(BotService.BotService)({
      list: () => Effect.sync(() => [...botsMap.values()]),
      get: (projectId) => Effect.sync(() => botsMap.get(projectId)!),
      getUsage: (projectId) =>
        Effect.sync(() => {
          const bot = botsMap.get(projectId)!;
          const resolved = resolveBotLimits({ limits: bot.limits });
          return {
            projectId,
            limits: {
              mode: resolved.mode,
              runsPerDay: resolved.runsPerDay,
              tokensPerDay: resolved.tokensPerDay,
            },
            usage: {
              runs: 3,
              tokens: 45_000,
              dayStartAt: "2026-10-01T00:00:00.000Z",
            },
          };
        }),
      create: (input) =>
        Effect.gen(function* () {
          const current = yield* settings.getSettings.pipe(Effect.orDie);
          if (!current.botsEnabled) {
            return yield* new BotOperationError({
              operation: "create",
              reason: "bots_disabled",
            });
          }
          const resolved = resolveBotLimits({ limits: input.limits });
          const record: BotRecord = {
            projectId: BOT_ID,
            name: input.name,
            goal: input.goal ?? "",
            modelSelection: input.modelSelection ?? null,
            paused: false,
            limits: {
              mode: resolved.mode,
              runsPerDay: resolved.runsPerDay,
              tokensPerDay: resolved.tokensPerDay,
            },
            approvals: input.approvals ?? "t3_gate",
            payments: input.payments ?? "blocked",
            workspaceRoot: "/tmp/bots/digest",
            createdAt: DateTime.formatIso(EPOCH),
            updatedAt: DateTime.formatIso(EPOCH),
          };
          botsMap.set(record.projectId, record);
          return record;
        }),
      update: (input) =>
        Effect.sync(() => {
          const current = botsMap.get(input.projectId)!;
          const nextLimits =
            input.limits === undefined
              ? current.limits
              : resolveBotLimits({ limits: input.limits });
          const next: BotRecord = {
            ...current,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.goal === undefined ? {} : { goal: input.goal }),
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
            ...(input.paused === undefined ? {} : { paused: input.paused }),
            ...(nextLimits === undefined ? {} : { limits: nextLimits }),
            ...(input.approvals === undefined ? {} : { approvals: input.approvals }),
            ...(input.payments === undefined ? {} : { payments: input.payments }),
          };
          botsMap.set(input.projectId, next);
          return next;
        }),
    }),
  );

  const context = yield* Layer.build(deps);
  const toolkit = yield* BotToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(BotHandlers.layer).pipe(
        Layer.provide(Layer.succeedContext(context)),
      ),
    ),
  );
  const call = <Name extends keyof typeof BotToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope: McpInvocationContext.McpInvocationScope = threadScope(),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(context),
    );
  return { call, settings };
});

describe("bot MCP toolkit handlers", () => {
  it.effect(
    "lists, reads detail with triggers and recent runs, creates, updates, pauses, and resumes bots",
    () =>
      Effect.gen(function* () {
        const { call } = yield* makeHarness();

        expect(yield* call("t3_bot_read", {})).toEqual({ bots: [] });

        const created = yield* call("t3_bot_update", {
          action: "create",
          name: "PR Digest",
          goal: "Summarize open PRs",
        });
        expect(created).toEqual({
          bot: {
            id: BOT_ID,
            name: "PR Digest",
            goal: "Summarize open PRs",
            modelSelection: null,
            paused: false,
            limits: DEFAULT_BOT_LIMITS,
            approvals: "t3_gate",
            payments: "blocked",
          },
        });

        expect(yield* call("t3_bot_read", {})).toEqual({
          bots: [
            {
              id: BOT_ID,
              name: "PR Digest",
              goal: "Summarize open PRs",
              modelSelection: null,
              paused: false,
              limits: DEFAULT_BOT_LIMITS,
              approvals: "t3_gate",
              payments: "blocked",
            },
          ],
        });

        const detail = yield* call("t3_bot_read", { botId: BOT_ID });
        expect(detail).toMatchObject({
          bot: {
            id: BOT_ID,
            name: "PR Digest",
            limits: DEFAULT_BOT_LIMITS,
            todayUsage: {
              runs: 3,
              tokens: 45_000,
              dayStartAt: "2026-10-01T00:00:00.000Z",
            },
            triggers: [{ id: "task:digest-daily", title: "Morning digest" }],
            recentRuns: [
              { threadId: RUN_THREAD_1, title: "Morning digest run", status: "completed" },
            ],
          },
        });

        expect(yield* call("t3_bot_update", { action: "pause", botId: BOT_ID })).toMatchObject({
          bot: { id: BOT_ID, paused: true },
        });
        expect(yield* call("t3_bot_update", { action: "resume", botId: BOT_ID })).toMatchObject({
          bot: { id: BOT_ID, paused: false },
        });
        expect(
          yield* call("t3_bot_update", {
            action: "update",
            botId: BOT_ID,
            name: "Evening Digest",
            goal: "Summarize closed PRs",
            limits: { mode: "runs_only", runsPerDay: 10 },
            approvals: "provider",
            payments: "ask",
          }),
        ).toMatchObject({
          bot: {
            id: BOT_ID,
            name: "Evening Digest",
            goal: "Summarize closed PRs",
            limits: { mode: "runs_only", runsPerDay: 10 },
            approvals: "provider",
            payments: "ask",
          },
        });

        // Read-only client can read but cannot update.
        expect(yield* call("t3_bot_read", {}, clientScope("read-only"))).toMatchObject({
          bots: [{ id: BOT_ID }],
        });
        expect(
          yield* call(
            "t3_bot_update",
            { action: "pause", botId: BOT_ID },
            clientScope("read-only"),
          ),
        ).toMatchObject({ code: "capability_denied" });
      }).pipe(Effect.scoped),
  );

  it.effect("returns a clear error when bots are turned off", () =>
    Effect.gen(function* () {
      const { call } = yield* makeHarness({ botsEnabled: false });

      expect(yield* call("t3_bot_read", {})).toMatchObject({
        code: "invalid_request",
        message: BOTS_DISABLED_REASON,
      });
      expect(yield* call("t3_bot_update", { action: "create", name: "Blocked" })).toMatchObject({
        code: "invalid_request",
        message: BOTS_DISABLED_REASON,
      });
    }).pipe(Effect.scoped),
  );
});
