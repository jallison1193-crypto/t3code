import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { isTerminalRunStatus, ThreadManagementService } from "./ThreadManagementService.ts";

export interface RegisterCompletionWakeInput {
  readonly childThreadId: ThreadId;
  readonly notifyThreadId: ThreadId;
  readonly label?: string | undefined;
}

const PendingWake = Schema.Struct({
  childThreadId: ThreadId,
  notifyThreadId: ThreadId,
  label: Schema.optional(Schema.String),
});
type PendingWake = typeof PendingWake.Type;
const PendingWakesJson = Schema.fromJsonString(Schema.Array(PendingWake));
const decodePendingWakes = Schema.decodeUnknownEffect(PendingWakesJson);
const encodePendingWakes = Schema.encodeEffect(PendingWakesJson);

const MAX_DELIVERED_KEYS = 10_000;
const MAX_PENDING_WAKES = 500;

export class CompletionWakeService extends Context.Service<
  CompletionWakeService,
  {
    readonly registerWake: (input: RegisterCompletionWakeInput) => Effect.Effect<void>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/CompletionWakeService") {}

const deliveredKeyFor = (childThreadId: ThreadId, notifyThreadId: ThreadId, runId: RunId) =>
  `${childThreadId}\u0000${notifyThreadId}\u0000${runId}`;

const formatWakeText = (input: {
  readonly childThreadId: ThreadId;
  readonly label?: string | undefined;
  readonly childTitle?: string | undefined;
  readonly outcome: OrchestrationV2RunStatus;
}) => {
  const labelText = input.label?.trim() || input.childTitle?.trim() || "";
  const subject =
    labelText.length > 0
      ? `Launched thread "${labelText}" (${input.childThreadId})`
      : `Launched thread ${input.childThreadId}`;
  return `${subject} finished with status "${input.outcome}". Inspect its result with t3_thread_read (threadId: "${input.childThreadId}") if needed.`;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService;
  const childReactions = yield* KeyedLock.makeRunner<ThreadId>();
  const wakes = new Map<ThreadId, Map<ThreadId, PendingWake>>();
  const deliveredKeys = new Set<string>();

  // Pending links outlive a restart: a launched thread can finish after the server comes back.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const storePath = path.join(stateDir, "coordinator", "completion-wakes.json");
  const writes = yield* Semaphore.make(1);
  const stored = yield* fs.readFileString(storePath).pipe(
    Effect.flatMap(decodePendingWakes),
    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<PendingWake>)),
  );
  for (const entry of stored) {
    const byNotify = wakes.get(entry.childThreadId) ?? new Map<ThreadId, PendingWake>();
    byNotify.set(entry.notifyThreadId, entry);
    wakes.set(entry.childThreadId, byNotify);
  }

  const persist = writes.withPermit(
    Effect.gen(function* () {
      const entries = [...wakes.values()]
        .flatMap((byNotify) => [...byNotify.values()])
        .slice(-MAX_PENDING_WAKES);
      const content = yield* encodePendingWakes(entries);
      const staging = `${storePath}.staging`;
      yield* fs.makeDirectory(path.dirname(storePath), { recursive: true });
      yield* fs.writeFileString(staging, content);
      yield* fs.rename(staging, storePath);
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("saving completion wakes failed", { cause })),
    ),
  );

  const recordDelivered = (key: string): boolean => {
    if (deliveredKeys.has(key)) return false;
    if (deliveredKeys.size >= MAX_DELIVERED_KEYS) {
      const oldest = deliveredKeys.values().next().value;
      if (oldest !== undefined) deliveredKeys.delete(oldest);
    }
    deliveredKeys.add(key);
    return true;
  };

  const deliverWake = Effect.fnUntraced(function* (input: {
    readonly childThread: OrchestrationV2AppThread | null;
    readonly entry: PendingWake;
    readonly outcome: OrchestrationV2RunStatus;
    readonly runId: RunId;
  }) {
    if (
      !recordDelivered(
        deliveredKeyFor(input.entry.childThreadId, input.entry.notifyThreadId, input.runId),
      )
    ) {
      return;
    }

    const notify = yield* threads
      .getThreadRecords(input.entry.notifyThreadId, [])
      .pipe(Effect.catchCause(() => Effect.undefined));
    if (
      notify === undefined ||
      notify.thread.deletedAt !== null ||
      notify.thread.archivedAt !== null
    ) {
      return;
    }

    const suffix = `${input.entry.childThreadId}:${input.entry.notifyThreadId}:${input.runId}`;
    yield* threads
      .sendToThread({
        projectId: notify.thread.projectId,
        commandId: CommandId.make(`server:completion-wake:${suffix}`),
        threadId: input.entry.notifyThreadId,
        messageId: MessageId.make(`message:completion-wake:${suffix}`),
        senderThreadId: input.entry.childThreadId,
        text: formatWakeText({
          childThreadId: input.entry.childThreadId,
          label: input.entry.label,
          childTitle: input.childThread?.title,
          outcome: input.outcome,
        }),
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking thread after launched thread completion failed", {
            childThreadId: input.entry.childThreadId,
            notifyThreadId: input.entry.notifyThreadId,
            runId: input.runId,
            cause,
          }),
        ),
      );
  });

  const registerWake: CompletionWakeService["Service"]["registerWake"] = Effect.fnUntraced(
    function* (input) {
      if (input.childThreadId === input.notifyThreadId) return;
      yield* childReactions.run(
        input.childThreadId,
        Effect.gen(function* () {
          const entry: PendingWake = {
            childThreadId: input.childThreadId,
            notifyThreadId: input.notifyThreadId,
            ...(input.label === undefined ? {} : { label: input.label }),
          };
          const child = yield* threads
            .getThreadRecords(input.childThreadId, ["runs"])
            .pipe(Effect.catchCause(() => Effect.undefined));
          if (child !== undefined) {
            if (child.thread.deletedAt !== null) {
              wakes.get(input.childThreadId)?.delete(input.notifyThreadId);
              return;
            }
            const hasPendingRun = child.runs.some((run) => !isTerminalRunStatus(run.status));
            const latestRun = child.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
            if (
              !hasPendingRun &&
              latestRun !== undefined &&
              isTerminalRunStatus(latestRun.status)
            ) {
              const existing = wakes.get(input.childThreadId);
              if (existing !== undefined) {
                existing.delete(input.notifyThreadId);
                if (existing.size === 0) wakes.delete(input.childThreadId);
              }
              yield* deliverWake({
                childThread: child.thread,
                entry,
                outcome: latestRun.status,
                runId: latestRun.id,
              });
              return;
            }
          }

          let byNotify = wakes.get(input.childThreadId);
          if (byNotify === undefined) {
            byNotify = new Map<ThreadId, PendingWake>();
            wakes.set(input.childThreadId, byNotify);
          }
          byNotify.set(input.notifyThreadId, entry);
        }),
      );
      yield* persist;
    },
  );

  const handle: CompletionWakeService["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "thread.deleted") {
        yield* childReactions.run(
          event.threadId,
          Effect.sync(() => {
            wakes.delete(event.threadId);
          }),
        );
        for (const childThreadId of Array.from(wakes.keys())) {
          yield* childReactions.run(
            childThreadId,
            Effect.sync(() => {
              const byNotify = wakes.get(childThreadId);
              if (byNotify === undefined) return;
              byNotify.delete(event.threadId);
              if (byNotify.size === 0) wakes.delete(childThreadId);
            }),
          );
        }
        const childPrefix = `${event.threadId}\u0000`;
        const notifySegment = `\u0000${event.threadId}\u0000`;
        for (const key of deliveredKeys) {
          if (key.startsWith(childPrefix) || key.includes(notifySegment)) {
            deliveredKeys.delete(key);
          }
        }
        return yield* persist;
      }

      if (event.type !== "run.updated") return;
      if (!isTerminalRunStatus(event.payload.status)) return;
      if (!wakes.has(event.threadId)) return;

      yield* childReactions.run(
        event.threadId,
        Effect.gen(function* () {
          const byNotify = wakes.get(event.threadId);
          if (byNotify === undefined || byNotify.size === 0) return;

          const child = yield* threads
            .getThreadRecords(event.threadId, ["runs"])
            .pipe(Effect.catchCause(() => Effect.undefined));
          if (child !== undefined) {
            if (child.thread.deletedAt !== null) {
              wakes.delete(event.threadId);
              return;
            }
            if (child.runs.some((run) => !isTerminalRunStatus(run.status))) {
              return;
            }
          }

          const targets = [...byNotify.values()];
          wakes.delete(event.threadId);
          for (const entry of targets) {
            yield* deliverWake({
              childThread: child?.thread ?? null,
              entry,
              outcome: event.payload.status,
              runId: event.payload.id,
            });
          }
        }),
      );
      yield* persist;
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("handling completion wake domain event failed", {
            threadId: event.threadId,
            type: event.type,
            cause,
          }),
        ),
      ),
  );

  const start: CompletionWakeService["Service"]["start"] = Effect.fn("CompletionWakeService.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => handle(event)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("completion wake event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return { registerWake, handle, start } satisfies CompletionWakeService["Service"];
});

export const layer = Layer.effect(CompletionWakeService, make);
