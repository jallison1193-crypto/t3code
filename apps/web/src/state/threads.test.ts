import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { WORK_MODE_TAG } from "@t3tools/client-runtime/state/thread-mode";
import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { AppMode } from "@t3tools/contracts/settings";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { createRunningThreadKeepAliveAtom, wrapNewThreadWorkTag } from "./threads";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

type Status = "running" | "starting" | "preparing" | "queued" | "waiting" | "idle";
function shell(id: string, status: Status | null) {
  return { id: ThreadId.make(id), status: status ?? "idle" } satisfies Pick<
    OrchestrationV2ThreadShell,
    "id" | "status"
  >;
}
function detail(id: string, status: Status, overrides: Partial<EnvironmentThreadState> = {}) {
  const projection = makeThreadProjectionFixture();
  const threadId = ThreadId.make(id);
  const thread = {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runs:
      status === "idle"
        ? []
        : [
            {
              id: RunId.make(`run-${id}`),
              threadId,
              ordinal: 1,
              providerInstanceId: projection.thread.providerInstanceId,
              modelSelection: projection.thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message-${id}`),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: projection.updatedAt,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
  };
  return AsyncResult.success<EnvironmentThreadState>({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(thread),
    ...overrides,
  });
}

function makeHarness() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const environmentIds = Atom.make<ReadonlyArray<EnvironmentId>>([LOCAL, REMOTE]).pipe(
    Atom.keepAlive,
  );
  const threads = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<ReturnType<typeof shell>>>([]).pipe(Atom.keepAlive),
  );
  const keys = new Set<string>();
  const states = Atom.family((_key: string) =>
    Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState>>(
      AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
    ),
  );
  const stateAtom = (environmentId: EnvironmentId, threadId: string) => {
    const key = `${environmentId}:${threadId}`;
    keys.add(key);
    return states(key);
  };
  const keepAlive = createRunningThreadKeepAliveAtom({
    environmentIdsAtom: environmentIds,
    threadsAtom: threads,
    stateAtom,
  });
  registry.mount(keepAlive);
  return {
    registry,
    environmentIds,
    threads,
    stateAtom,
    keepAlive,
    openStreams: () => {
      flush();
      return [...keys].filter((key) => registry.getNodes().has(states(key))).toSorted();
    },
  };
}

describe("createRunningThreadKeepAliveAtom", () => {
  it("keeps running threads open across shell updates and thread view visits", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "idle"), shell("c", null)]);
    h.registry.set(h.threads(REMOTE), [shell("d", "starting")]);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);

    const live = detail("a", "running");
    h.registry.set(h.stateAtom(LOCAL, "a"), live);
    h.registry.mount(h.stateAtom(LOCAL, "a"))();

    const kept = h.registry.get(h.keepAlive);
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "idle")]);
    expect(h.registry.get(h.keepAlive)).toBe(kept);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);
    expect(h.registry.get(h.stateAtom(LOCAL, "a"))).toBe(live);
  });

  it("holds a stopped thread until its own stream is live and shows the stop", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "running"),
      shell("b", "running"),
      shell("c", "running"),
    ]);
    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "running"));
    h.registry.set(
      h.stateAtom(LOCAL, "c"),
      detail("c", "running", { status: "cached", error: Option.some("Could not sync.") }),
    );

    h.registry.set(h.threads(LOCAL), [shell("a", "idle"), shell("b", "idle"), shell("c", "idle")]);
    expect(h.openStreams()).toEqual(["local:a", "local:b"]);

    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "idle"));
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "idle", { status: "synchronizing" }));
    expect(h.openStreams()).toEqual(["local:b"]);
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "idle"));
    expect(h.openStreams()).toEqual([]);
  });

  it("follows environments that connect and go away", () => {
    const h = makeHarness();
    h.registry.set(h.environmentIds, [LOCAL]);
    h.registry.set(h.threads(REMOTE), [shell("d", "running")]);
    expect(h.openStreams()).toEqual([]);

    h.registry.set(h.environmentIds, [LOCAL, REMOTE]);
    expect(h.openStreams()).toEqual(["remote:d"]);

    h.registry.set(h.stateAtom(REMOTE, "d"), detail("d", "running"));
    h.registry.set(h.threads(REMOTE), [shell("d", "idle")]);
    expect(h.openStreams()).toEqual(["remote:d"]);
    h.registry.set(h.environmentIds, [LOCAL]);
    expect(h.openStreams()).toEqual([]);
  });
});

describe("wrapNewThreadWorkTag", () => {
  class TestCommandError extends Schema.TaggedError<TestCommandError>()("TestCommandError", {
    message: Schema.String,
  }) {}

  interface TestTarget {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly threadId: ThreadId;
      readonly bootstrap?: { readonly createThread?: unknown };
    };
  }

  function makeTagCommand<E = never>(effect: Effect.Effect<unknown, E>) {
    const calls: Array<unknown> = [];
    const command: AtomCommand<
      {
        readonly environmentId: EnvironmentId;
        readonly input: {
          readonly threadId: ThreadId;
          readonly tag: string;
          readonly tagged: boolean;
        };
      },
      unknown,
      E
    > = {
      label: "test:set-tag",
      run: (_registry, target) =>
        Effect.sync(() => {
          calls.push(target);
        }).pipe(Effect.andThen(effect)),
    };
    return { command, calls };
  }

  it.effect(
    "snapshots appMode before async creation for explicit and bootstrap new threads, and skips existing threads",
    () =>
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        const threadId = ThreadId.make("new-thread");
        let currentMode: AppMode = "work";
        const createStarted = yield* Deferred.make<void>();
        const releaseCreate = yield* Deferred.make<void>();
        const createdValue = { created: true } as const;
        const createCommand: AtomCommand<TestTarget, { readonly created: true }, TestCommandError> =
          {
            label: "test:create",
            run: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(createStarted, undefined);
                yield* Deferred.await(releaseCreate);
                return createdValue;
              }),
          };
        const setTag = makeTagCommand(Effect.void);
        const wrappedCreate = wrapNewThreadWorkTag({
          command: createCommand,
          setTag: setTag.command,
          shouldTag: () => true,
          readAppMode: () => currentMode,
          onTagFailure: vi.fn(),
        });

        const fiber = yield* Effect.forkChild(
          wrappedCreate.run(registry, {
            environmentId: LOCAL,
            input: { threadId },
          }),
        );
        yield* Deferred.await(createStarted);
        // Flip appMode while creation is still in flight; the snapshotted mode must win.
        currentMode = "code";
        yield* Deferred.succeed(releaseCreate, undefined);
        expect(yield* Fiber.join(fiber)).toBe(createdValue);
        expect(setTag.calls).toEqual([
          {
            environmentId: LOCAL,
            input: { threadId, tag: WORK_MODE_TAG, tagged: true },
          },
        ]);

        // Bootstrap new thread tags when appMode is work; existing thread turn does not.
        const bootstrapTag = makeTagCommand(Effect.void);
        const startTurnCommand: AtomCommand<
          TestTarget,
          { readonly started: true },
          TestCommandError
        > = {
          label: "test:start-turn",
          run: () => Effect.succeed({ started: true } as const),
        };
        currentMode = "work";
        const wrappedStartTurn = wrapNewThreadWorkTag({
          command: startTurnCommand,
          setTag: bootstrapTag.command,
          shouldTag: (target) => target.input.bootstrap?.createThread !== undefined,
          readAppMode: () => currentMode,
          onTagFailure: vi.fn(),
        });

        yield* wrappedStartTurn.run(registry, {
          environmentId: LOCAL,
          input: { threadId: ThreadId.make("existing-thread") },
        });
        expect(bootstrapTag.calls).toEqual([]);

        yield* wrappedStartTurn.run(registry, {
          environmentId: LOCAL,
          input: { threadId: ThreadId.make("bootstrap-thread"), bootstrap: { createThread: {} } },
        });
        expect(bootstrapTag.calls).toEqual([
          {
            environmentId: LOCAL,
            input: {
              threadId: ThreadId.make("bootstrap-thread"),
              tag: WORK_MODE_TAG,
              tagged: true,
            },
          },
        ]);

        // Flipping from code -> work mid-flight must not retroactively tag a code thread.
        currentMode = "code";
        const codeCreateStarted = yield* Deferred.make<void>();
        const releaseCodeCreate = yield* Deferred.make<void>();
        const codeFiber = yield* Effect.forkChild(
          wrapNewThreadWorkTag({
            command: {
              label: "test:create-code",
              run: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(codeCreateStarted, undefined);
                  yield* Deferred.await(releaseCodeCreate);
                  return { created: true } as const;
                }),
            },
            setTag: bootstrapTag.command,
            shouldTag: () => true,
            readAppMode: () => currentMode,
            onTagFailure: vi.fn(),
          }).run(registry, {
            environmentId: LOCAL,
            input: { threadId: ThreadId.make("code-thread") },
          }),
        );
        yield* Deferred.await(codeCreateStarted);
        currentMode = "work";
        yield* Deferred.succeed(releaseCodeCreate, undefined);
        yield* Fiber.join(codeFiber);
        expect(bootstrapTag.calls).toHaveLength(1);
      }),
  );

  it.effect("reports tagging failure visibly without failing an accepted creation or turn", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const threadId = ThreadId.make("accepted-thread");
      const onTagFailure = vi.fn();
      const tagError = new TestCommandError({ message: "tag permission denied" });
      const setTag = makeTagCommand(Effect.fail(tagError));
      const acceptedValue = { threadId };
      const wrapped = wrapNewThreadWorkTag({
        command: {
          label: "test:start-turn",
          run: () => Effect.succeed(acceptedValue),
        },
        setTag: setTag.command,
        shouldTag: () => true,
        readAppMode: () => "work",
        onTagFailure,
      });

      const result = yield* wrapped.run(registry, { environmentId: LOCAL, input: { threadId } });
      expect(result).toBe(acceptedValue);
      expect(onTagFailure).toHaveBeenCalledExactlyOnceWith(tagError);
    }),
  );

  it.effect(
    "skips tagging when creation fails and suppresses failure toast on interrupted tagging",
    () =>
      Effect.gen(function* () {
        const registry = AtomRegistry.make();
        const onTagFailure = vi.fn();
        const setTag = makeTagCommand(Effect.failCause(Cause.interrupt(1)));
        const failedCreate = wrapNewThreadWorkTag({
          command: {
            label: "test:create",
            run: () => Effect.fail(new TestCommandError({ message: "create failed" })),
          },
          setTag: setTag.command,
          shouldTag: () => true,
          readAppMode: () => "work",
          onTagFailure,
        });
        const failExit = yield* Effect.exit(
          failedCreate.run(registry, {
            environmentId: LOCAL,
            input: { threadId: ThreadId.make("failed") },
          }),
        );
        expect(Exit.isFailure(failExit)).toBe(true);
        expect(setTag.calls).toEqual([]);
        expect(onTagFailure).not.toHaveBeenCalled();

        const interruptedTag = wrapNewThreadWorkTag({
          command: {
            label: "test:create",
            run: () => Effect.succeed("ok"),
          },
          setTag: setTag.command,
          shouldTag: () => true,
          readAppMode: () => "work",
          onTagFailure,
        });
        expect(
          yield* interruptedTag.run(registry, {
            environmentId: LOCAL,
            input: { threadId: ThreadId.make("ok") },
          }),
        ).toBe("ok");
        expect(onTagFailure).not.toHaveBeenCalled();
      }),
  );
});
