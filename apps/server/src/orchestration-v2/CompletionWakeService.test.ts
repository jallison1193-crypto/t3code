// @effect-diagnostics nodeBuiltinImport:off -- Tests use a real temp directory for the wake store.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as CompletionWakeService from "./CompletionWakeService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const PROJECT_ID = ProjectId.make("project:completion-wake");
const NOW = DateTime.makeUnsafe("2026-11-18T00:00:00.000Z");

function makeThread(
  id: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    id,
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as unknown as OrchestrationV2AppThread;
}

function makeRun(
  id: RunId,
  threadId: ThreadId,
  status: OrchestrationV2RunStatus,
  ordinal = 1,
): OrchestrationV2Run {
  return {
    id,
    threadId,
    ordinal,
    status,
    userMessageId: MessageId.make(`msg:${id}`),
    providerInstanceId: ProviderInstanceId.make("codex"),
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as OrchestrationV2Run;
}

function makeRunUpdatedEvent(
  threadId: ThreadId,
  run: OrchestrationV2Run,
  sequence = 1,
): OrchestrationV2DomainEvent {
  return {
    sequence,
    eventId: EventId.make(`event:run-updated:${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    threadId,
    projectId: PROJECT_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd:run-updated:${sequence}`),
    causationEventId: null,
    correlationId: null,
    type: "run.updated",
    payload: run,
  } as unknown as OrchestrationV2DomainEvent;
}

function makeThreadDeletedEvent(threadId: ThreadId, sequence = 1): OrchestrationV2DomainEvent {
  return {
    sequence,
    eventId: EventId.make(`event:thread-deleted:${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    threadId,
    projectId: PROJECT_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd:thread-deleted:${sequence}`),
    causationEventId: null,
    correlationId: null,
    type: "thread.deleted",
    payload: { deletedAt: NOW },
  } as unknown as OrchestrationV2DomainEvent;
}

type ThreadRecordEntry = {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
};

type SentMessage = Parameters<ThreadManagementService["Service"]["sendToThread"]>[0];

function makeHarness(options?: {
  readonly records?: Map<ThreadId, ThreadRecordEntry>;
  readonly sendError?: Error;
  readonly onSend?: (input: SentMessage) => Effect.Effect<void>;
  readonly stateRoot?: string;
}) {
  const records = options?.records ?? new Map<ThreadId, ThreadRecordEntry>();
  const stateRoot =
    options?.stateRoot ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-completion-wake-"));
  const sent: Array<SentMessage> = [];

  return Effect.gen(function* () {
    const eventQueue = yield* Queue.unbounded<OrchestrationV2DomainEvent>();

    const layer = CompletionWakeService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(eventQueue),
          }),
          Layer.mock(ThreadManagementService)({
            getThreadRecords: ((threadId: ThreadId) => {
              const found = records.get(threadId);
              if (found === undefined) {
                return Effect.fail(new Error(`Missing thread ${threadId}`) as never);
              }
              return Effect.succeed({
                thread: found.thread,
                runs: found.runs,
              } as never);
            }) as ThreadManagementService["Service"]["getThreadRecords"],
            sendToThread: ((input: SentMessage) =>
              Effect.gen(function* () {
                if (options?.sendError !== undefined) {
                  return yield* Effect.fail(options.sendError as never);
                }
                sent.push(input);
                if (options?.onSend !== undefined) {
                  yield* options.onSend(input);
                }
                return {} as never;
              })) as ThreadManagementService["Service"]["sendToThread"],
          }),
          ServerConfig.layerTest(stateRoot, stateRoot).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    );

    return { records, sent, eventQueue, stateRoot, layer };
  });
}

describe("CompletionWakeService", () => {
  it.effect(
    "ignores non-terminal run updates and sends a single-use wake when the run reaches terminal status",
    () =>
      Effect.gen(function* () {
        const coordinatorId = ThreadId.make("thread:coordinator");
        const workerId = ThreadId.make("thread:worker");
        const runId = RunId.make("run:worker-1");
        const harness = yield* makeHarness();
        harness.records.set(coordinatorId, { thread: makeThread(coordinatorId), runs: [] });
        harness.records.set(workerId, {
          thread: makeThread(workerId, { title: "Worker Alpha" }),
          runs: [makeRun(runId, workerId, "running")],
        });

        yield* Effect.gen(function* () {
          const service = yield* CompletionWakeService.CompletionWakeService;
          yield* service.registerWake({
            childThreadId: workerId,
            notifyThreadId: coordinatorId,
            label: "Worker Alpha",
          });

          // Non-terminal update does not wake
          yield* service.handle(
            makeRunUpdatedEvent(workerId, makeRun(runId, workerId, "running"), 1),
          );
          assert.lengthOf(harness.sent, 0);

          // Update record to terminal and emit terminal run.updated
          const completedRun = makeRun(runId, workerId, "completed");
          harness.records.set(workerId, {
            thread: makeThread(workerId, { title: "Worker Alpha" }),
            runs: [completedRun],
          });
          yield* service.handle(makeRunUpdatedEvent(workerId, completedRun, 2));

          assert.lengthOf(harness.sent, 1);
          assert.equal(harness.sent[0]?.threadId, coordinatorId);
          assert.equal(harness.sent[0]?.senderThreadId, workerId);
          assert.equal(harness.sent[0]?.mode, "queue");
          assert.equal(harness.sent[0]?.createdBy, "agent");
          assert.equal(harness.sent[0]?.creationSource, "server");
          assert.include(harness.sent[0]?.text ?? "", workerId);
          assert.include(harness.sent[0]?.text ?? "", "Worker Alpha");
          assert.include(harness.sent[0]?.text ?? "", "completed");
          assert.include(harness.sent[0]?.text ?? "", "t3_thread_read");

          // Subsequent run completion without re-registering is not woken (single-use)
          const run2 = makeRun(RunId.make("run:worker-2"), workerId, "failed", 2);
          harness.records.set(workerId, {
            thread: makeThread(workerId, { title: "Worker Alpha" }),
            runs: [completedRun, run2],
          });
          yield* service.handle(makeRunUpdatedEvent(workerId, run2, 3));
          assert.lengthOf(harness.sent, 1);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("keeps pending wakes across a restart", () =>
    Effect.gen(function* () {
      const coordinatorId = ThreadId.make("thread:coordinator");
      const workerId = ThreadId.make("thread:worker");
      const before = yield* makeHarness();
      before.records.set(coordinatorId, { thread: makeThread(coordinatorId), runs: [] });
      before.records.set(workerId, { thread: makeThread(workerId), runs: [] });
      yield* Effect.gen(function* () {
        const service = yield* CompletionWakeService.CompletionWakeService;
        yield* service.registerWake({ childThreadId: workerId, notifyThreadId: coordinatorId });
      }).pipe(Effect.provide(before.layer));

      const after = yield* makeHarness({ records: before.records, stateRoot: before.stateRoot });
      const completedRun = makeRun(RunId.make("run:worker-1"), workerId, "completed");
      after.records.set(workerId, { thread: makeThread(workerId), runs: [completedRun] });
      yield* Effect.gen(function* () {
        const service = yield* CompletionWakeService.CompletionWakeService;
        yield* service.handle(makeRunUpdatedEvent(workerId, completedRun, 1));
      }).pipe(Effect.provide(after.layer));
      assert.lengthOf(after.sent, 1);
      assert.equal(after.sent[0]?.threadId, coordinatorId);
    }),
  );

  it.effect(
    "waits if another run on the child thread is still non-terminal, then wakes on final failure",
    () =>
      Effect.gen(function* () {
        const coordinatorId = ThreadId.make("thread:coordinator-multi");
        const workerId = ThreadId.make("thread:worker-multi");
        const run1 = RunId.make("run:multi-1");
        const run2 = RunId.make("run:multi-2");
        const harness = yield* makeHarness();
        harness.records.set(coordinatorId, { thread: makeThread(coordinatorId), runs: [] });
        harness.records.set(workerId, {
          thread: makeThread(workerId, { title: "Multi Worker" }),
          runs: [makeRun(run1, workerId, "completed", 1), makeRun(run2, workerId, "queued", 2)],
        });

        yield* Effect.gen(function* () {
          const service = yield* CompletionWakeService.CompletionWakeService;
          yield* service.registerWake({
            childThreadId: workerId,
            notifyThreadId: coordinatorId,
          });

          // First run finishes while second is still queued -> keep waiting
          yield* service.handle(
            makeRunUpdatedEvent(workerId, makeRun(run1, workerId, "completed", 1), 1),
          );
          assert.lengthOf(harness.sent, 0);

          // Second run fails -> now all runs are terminal -> wakes coordinator
          const failedRun2 = makeRun(run2, workerId, "failed", 2);
          harness.records.set(workerId, {
            thread: makeThread(workerId, { title: "Multi Worker" }),
            runs: [makeRun(run1, workerId, "completed", 1), failedRun2],
          });
          yield* service.handle(makeRunUpdatedEvent(workerId, failedRun2, 2));
          assert.lengthOf(harness.sent, 1);
          assert.include(harness.sent[0]?.text ?? "", "failed");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "delivers immediately and deduplicates if child is already terminal at registration",
    () =>
      Effect.gen(function* () {
        const coordinatorId = ThreadId.make("thread:coordinator-race");
        const workerId = ThreadId.make("thread:worker-race");
        const runId = RunId.make("run:race-1");
        const completedRun = makeRun(runId, workerId, "completed");
        const harness = yield* makeHarness();
        harness.records.set(coordinatorId, { thread: makeThread(coordinatorId), runs: [] });
        harness.records.set(workerId, {
          thread: makeThread(workerId, { title: "Fast Worker" }),
          runs: [completedRun],
        });

        yield* Effect.gen(function* () {
          const service = yield* CompletionWakeService.CompletionWakeService;
          yield* service.registerWake({
            childThreadId: workerId,
            notifyThreadId: coordinatorId,
            label: "Fast Worker",
          });
          // Replay / duplicate registration for same finished run should not wake twice
          yield* service.registerWake({
            childThreadId: workerId,
            notifyThreadId: coordinatorId,
            label: "Fast Worker",
          });
          yield* service.handle(makeRunUpdatedEvent(workerId, completedRun, 1));

          assert.lengthOf(harness.sent, 1);
          assert.include(harness.sent[0]?.text ?? "", "Fast Worker");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("ignores self-wakes and cleans up registrations on thread.deleted", () =>
    Effect.gen(function* () {
      const coordinatorId = ThreadId.make("thread:coordinator-cleanup");
      const workerA = ThreadId.make("thread:worker-cleanup-a");
      const workerB = ThreadId.make("thread:worker-cleanup-b");
      const runA = RunId.make("run:cleanup-a");
      const runB = RunId.make("run:cleanup-b");
      const harness = yield* makeHarness();
      harness.records.set(coordinatorId, { thread: makeThread(coordinatorId), runs: [] });
      harness.records.set(workerA, {
        thread: makeThread(workerA),
        runs: [makeRun(runA, workerA, "running")],
      });
      harness.records.set(workerB, {
        thread: makeThread(workerB),
        runs: [makeRun(runB, workerB, "running")],
      });

      yield* Effect.gen(function* () {
        const service = yield* CompletionWakeService.CompletionWakeService;
        // Self-wake ignored
        yield* service.registerWake({
          childThreadId: coordinatorId,
          notifyThreadId: coordinatorId,
        });
        yield* service.registerWake({ childThreadId: workerA, notifyThreadId: coordinatorId });
        yield* service.registerWake({ childThreadId: workerB, notifyThreadId: coordinatorId });

        // Delete child workerA -> workerA registration dropped
        yield* service.handle(makeThreadDeletedEvent(workerA, 1));
        const completedA = makeRun(runA, workerA, "completed");
        harness.records.set(workerA, { thread: makeThread(workerA), runs: [completedA] });
        yield* service.handle(makeRunUpdatedEvent(workerA, completedA, 2));
        assert.lengthOf(harness.sent, 0);

        // Delete notifyThread coordinatorId -> workerB registration dropped
        yield* service.handle(makeThreadDeletedEvent(coordinatorId, 3));
        const completedB = makeRun(runB, workerB, "completed");
        harness.records.set(workerB, { thread: makeThread(workerB), runs: [completedB] });
        yield* service.handle(makeRunUpdatedEvent(workerB, completedB, 4));
        assert.lengthOf(harness.sent, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not crash when notifyThread is archived, missing, or sendToThread fails", () =>
    Effect.gen(function* () {
      const archivedCoordinator = ThreadId.make("thread:archived-coordinator");
      const workerId = ThreadId.make("thread:worker-archived");
      const runId = RunId.make("run:archived-1");
      const harness = yield* makeHarness({ sendError: new Error("provider disabled") });
      harness.records.set(archivedCoordinator, {
        thread: makeThread(archivedCoordinator, { archivedAt: NOW }),
        runs: [],
      });
      harness.records.set(workerId, {
        thread: makeThread(workerId),
        runs: [makeRun(runId, workerId, "running")],
      });

      yield* Effect.gen(function* () {
        const service = yield* CompletionWakeService.CompletionWakeService;
        yield* service.registerWake({
          childThreadId: workerId,
          notifyThreadId: archivedCoordinator,
        });
        const completed = makeRun(runId, workerId, "completed");
        harness.records.set(workerId, { thread: makeThread(workerId), runs: [completed] });
        yield* service.handle(makeRunUpdatedEvent(workerId, completed, 1));

        // Un-archive and test sendToThread error swallowing
        harness.records.set(archivedCoordinator, {
          thread: makeThread(archivedCoordinator, { archivedAt: null }),
          runs: [],
        });
        const run2 = RunId.make("run:archived-2");
        harness.records.set(workerId, {
          thread: makeThread(workerId),
          runs: [completed, makeRun(run2, workerId, "running", 2)],
        });
        yield* service.registerWake({
          childThreadId: workerId,
          notifyThreadId: archivedCoordinator,
        });
        const completed2 = makeRun(run2, workerId, "completed", 2);
        harness.records.set(workerId, {
          thread: makeThread(workerId),
          runs: [completed, completed2],
        });
        yield* service.handle(makeRunUpdatedEvent(workerId, completed2, 2));
        assert.lengthOf(harness.sent, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "start() subscribes to OrchestratorV2.streamDomainEvents and wakes on terminal event",
    () =>
      Effect.gen(function* () {
        const woken = yield* Deferred.make<SentMessage>();
        const coordinatorId = ThreadId.make("thread:coordinator-stream");
        const workerId = ThreadId.make("thread:worker-stream");
        const runId = RunId.make("run:stream-1");

        const harness = yield* makeHarness({
          onSend: (msg) => Deferred.succeed(woken, msg).pipe(Effect.asVoid),
        });
        harness.records.set(coordinatorId, { thread: makeThread(coordinatorId), runs: [] });
        harness.records.set(workerId, {
          thread: makeThread(workerId, { title: "Stream Worker" }),
          runs: [makeRun(runId, workerId, "running")],
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* CompletionWakeService.CompletionWakeService;
            yield* service.start();
            yield* service.registerWake({
              childThreadId: workerId,
              notifyThreadId: coordinatorId,
            });

            const completed = makeRun(runId, workerId, "completed");
            harness.records.set(workerId, {
              thread: makeThread(workerId, { title: "Stream Worker" }),
              runs: [completed],
            });
            yield* Queue.offer(harness.eventQueue, makeRunUpdatedEvent(workerId, completed, 1));

            const sent = yield* Deferred.await(woken);
            assert.equal(sent.threadId, coordinatorId);
            assert.include(sent.text, "Stream Worker");
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
  );
});
