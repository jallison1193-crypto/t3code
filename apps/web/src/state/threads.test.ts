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
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

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
  interface TestTarget {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly threadId: ThreadId;
      readonly bootstrap?: { readonly createThread?: unknown };
    };
  }

  function makeTagCommand(
    result: AsyncResult.Success<unknown, unknown> | AsyncResult.Failure<unknown, unknown>,
  ) {
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
      unknown
    > = {
      label: "test:set-tag",
      run: async (_registry, target) => {
        calls.push(target);
        return result;
      },
    };
    return { command, calls };
  }

  it("snapshots appMode before async creation for explicit and bootstrap new threads, and skips existing threads", async () => {
    const registry = AtomRegistry.make();
    const threadId = ThreadId.make("new-thread");
    let currentMode: AppMode = "work";
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createdResult = AsyncResult.success({ created: true } as const);
    const createCommand: AtomCommand<TestTarget, { readonly created: true }, Error> = {
      label: "test:create",
      run: async () => {
        await createStarted;
        return createdResult;
      },
    };
    const setTag = makeTagCommand(AsyncResult.success(undefined));
    const wrappedCreate = wrapNewThreadWorkTag({
      command: createCommand,
      setTag: setTag.command,
      shouldTag: () => true,
      readAppMode: () => currentMode,
      onTagFailure: vi.fn(),
    });

    const pending = wrappedCreate.run(registry, {
      environmentId: LOCAL,
      input: { threadId },
    });
    // Flip appMode while creation is still in flight; the snapshotted mode must win.
    currentMode = "code";
    releaseCreate();
    expect(await pending).toBe(createdResult);
    expect(setTag.calls).toEqual([
      {
        environmentId: LOCAL,
        input: { threadId, tag: WORK_MODE_TAG, tagged: true },
      },
    ]);

    // Bootstrap new thread tags when appMode is work; existing thread turn does not.
    const bootstrapTag = makeTagCommand(AsyncResult.success(undefined));
    const startTurnCommand: AtomCommand<TestTarget, { readonly started: true }, Error> = {
      label: "test:start-turn",
      run: async () => AsyncResult.success({ started: true }),
    };
    currentMode = "work";
    const wrappedStartTurn = wrapNewThreadWorkTag({
      command: startTurnCommand,
      setTag: bootstrapTag.command,
      shouldTag: (target) => target.input.bootstrap?.createThread !== undefined,
      readAppMode: () => currentMode,
      onTagFailure: vi.fn(),
    });

    await wrappedStartTurn.run(registry, {
      environmentId: LOCAL,
      input: { threadId: ThreadId.make("existing-thread") },
    });
    expect(bootstrapTag.calls).toEqual([]);

    await wrappedStartTurn.run(registry, {
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
    let releaseCodeCreate!: () => void;
    const codePending = wrapNewThreadWorkTag({
      command: {
        label: "test:create-code",
        run: async () => {
          await new Promise<void>((resolve) => {
            releaseCodeCreate = resolve;
          });
          return AsyncResult.success({ created: true });
        },
      },
      setTag: bootstrapTag.command,
      shouldTag: () => true,
      readAppMode: () => currentMode,
      onTagFailure: vi.fn(),
    }).run(registry, { environmentId: LOCAL, input: { threadId: ThreadId.make("code-thread") } });
    currentMode = "work";
    releaseCodeCreate();
    await codePending;
    expect(bootstrapTag.calls).toHaveLength(1);
  });

  it("reports tagging failure visibly without failing an accepted creation or turn", async () => {
    const registry = AtomRegistry.make();
    const threadId = ThreadId.make("accepted-thread");
    const onTagFailure = vi.fn();
    const tagError = new Error("tag permission denied");
    const setTag = makeTagCommand(AsyncResult.failure(Cause.fail(tagError)));
    const acceptedResult = AsyncResult.success({ threadId });
    const wrapped = wrapNewThreadWorkTag({
      command: {
        label: "test:start-turn",
        run: async () => acceptedResult,
      },
      setTag: setTag.command,
      shouldTag: () => true,
      readAppMode: () => "work",
      onTagFailure,
    });

    const result = await wrapped.run(registry, { environmentId: LOCAL, input: { threadId } });
    expect(result).toBe(acceptedResult);
    expect(onTagFailure).toHaveBeenCalledExactlyOnceWith(tagError);
  });

  it("skips tagging when creation fails and suppresses failure toast on interrupted tagging", async () => {
    const registry = AtomRegistry.make();
    const onTagFailure = vi.fn();
    const setTag = makeTagCommand(AsyncResult.failure(Cause.interrupt(1)));
    const failedCreate = wrapNewThreadWorkTag({
      command: {
        label: "test:create",
        run: async () => AsyncResult.failure(Cause.fail(new Error("create failed"))),
      },
      setTag: setTag.command,
      shouldTag: () => true,
      readAppMode: () => "work",
      onTagFailure,
    });
    const failResult = await failedCreate.run(registry, {
      environmentId: LOCAL,
      input: { threadId: ThreadId.make("failed") },
    });
    expect(failResult._tag).toBe("Failure");
    expect(setTag.calls).toEqual([]);
    expect(onTagFailure).not.toHaveBeenCalled();

    const okResult = AsyncResult.success("ok");
    const interruptedTag = wrapNewThreadWorkTag({
      command: {
        label: "test:create",
        run: async () => okResult,
      },
      setTag: setTag.command,
      shouldTag: () => true,
      readAppMode: () => "work",
      onTagFailure,
    });
    expect(
      await interruptedTag.run(registry, {
        environmentId: LOCAL,
        input: { threadId: ThreadId.make("ok") },
      }),
    ).toBe(okResult);
    expect(onTagFailure).not.toHaveBeenCalled();
  });
});
