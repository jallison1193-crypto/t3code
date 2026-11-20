import { t } from "gt-react";
import { createChildThreadApprovalsAtom } from "@t3tools/client-runtime/state/thread-requests";
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  type AtomCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WORK_MODE_TAG } from "@t3tools/client-runtime/state/thread-mode";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createOlderSettledThreadAtoms,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
} from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
  ThreadTag,
} from "@t3tools/contracts";
import type { AppMode } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";

export const threadFamilies = createThreadFamilyAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
export const olderSettledThreads = createOlderSettledThreadAtoms(
  connectionAtomRuntime,
  environmentShell.stateAtom,
);
const baseThreadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  threadFamilies.snapshotAtom,
);

let cachedReadAppMode: (() => AppMode) | null = null;

// Lazy imports keep this state module free of hook/UI cycles for partial test mocks.
function readDefaultAppMode(): AppMode | Promise<AppMode> {
  if (cachedReadAppMode !== null) return cachedReadAppMode();
  return import("../hooks/useSettings").then(({ getClientSettings }) => {
    cachedReadAppMode = () => getClientSettings().appMode;
    return cachedReadAppMode();
  });
}

async function notifyWorkModeTagFailure(error: unknown): Promise<void> {
  const { stackedThreadToast, toastManager } = await import("../components/ui/toast");
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: t("Failed to tag thread for Work mode"),
      description:
        error instanceof Error
          ? `${error.message} ${t("You can move it to Work from the thread menu.")}`
          : t("You can move it to Work from the thread menu."),
    }),
  );
}

export function wrapNewThreadWorkTag<
  Target extends {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  },
  A,
  E,
>(input: {
  readonly command: AtomCommand<Target, A, E>;
  readonly setTag: AtomCommand<
    {
      readonly environmentId: EnvironmentId;
      readonly input: {
        readonly threadId: ThreadId;
        readonly tag: ThreadTag;
        readonly tagged: boolean;
      };
    },
    unknown,
    unknown
  >;
  readonly shouldTag: (target: Target) => boolean;
  readonly readAppMode?: () => AppMode | Promise<AppMode>;
  readonly onTagFailure?: (error: unknown) => void | Promise<void>;
}): AtomCommand<Target, A, E> {
  const readAppMode = input.readAppMode ?? readDefaultAppMode;
  const onTagFailure = input.onTagFailure ?? notifyWorkModeTagFailure;
  return {
    label: input.command.label,
    run: async (registry, target) => {
      // Snapshot intended mode before async creation so switching modes mid-flight cannot misclassify the new thread.
      let tagAsWork = false;
      if (input.shouldTag(target)) {
        const mode = readAppMode();
        tagAsWork = (typeof mode === "string" ? mode : await mode) === "work";
      }
      const result = await input.command.run(registry, target);
      if (result._tag === "Success" && tagAsWork) {
        const tagResult = await runAtomCommand(
          registry,
          input.setTag,
          {
            environmentId: target.environmentId,
            input: {
              threadId: target.input.threadId,
              tag: WORK_MODE_TAG,
              tagged: true,
            },
          },
          { reportFailure: false },
        );
        if (tagResult._tag === "Failure" && !isAtomCommandInterrupted(tagResult)) {
          await onTagFailure(squashAtomCommandFailure(tagResult));
        }
      }
      return result;
    },
  };
}

export const threadEnvironment = {
  ...baseThreadEnvironment,
  create: wrapNewThreadWorkTag({
    command: baseThreadEnvironment.create,
    setTag: baseThreadEnvironment.setTag,
    shouldTag: () => true,
  }),
  startTurn: wrapNewThreadWorkTag({
    command: baseThreadEnvironment.startTurn,
    setTag: baseThreadEnvironment.setTag,
    shouldTag: (target) => target.input.bootstrap?.createThread !== undefined,
  }),
};
const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
});
export const childThreadApprovalsAtom = createChildThreadApprovalsAtom({
  childThreadInputsAtom: environmentThreadShells.childThreadInputsAtom,
  pendingRequestsAtom: environmentThreadDetails.pendingRequestsAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = AsyncResult.getOrElse(result, () => EMPTY_ENVIRONMENT_THREAD_STATE);
  return state;
}

const isRunning = (status: string) =>
  status === "preparing" || status === "queued" || status === "starting" || status === "running";

type KeptThreads = ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>>;

function isDetailDone<E>(result: AsyncResult.AsyncResult<EnvironmentThreadState, E>): boolean {
  if (!AsyncResult.isSuccess(result)) return true;
  const { status, data, error } = result.value;
  if (status === "deleted" || Option.isSome(error)) return true;
  return (
    status === "live" &&
    !Option.exists(data, (thread) => thread.runs.some((run) => isRunning(run.status)))
  );
}

/** Keeps stopped threads mounted until their independent detail stream is live and also reports stopped. */
export function createRunningThreadKeepAliveAtom<E>(input: {
  readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly threadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "status">>>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
}) {
  const runningThreadIdsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ThreadId> = [];
    return Atom.make((get) => {
      const running = get(input.threadsAtom(environmentId)).flatMap((thread) =>
        isRunning(thread.status) ? [thread.id] : [],
      );
      if (arrayElementsEqual(previous, running)) return previous;
      previous = running;
      return running;
    }).pipe(Atom.withLabel(`web-running-thread-ids:${environmentId}`));
  });

  return Atom.make((get): KeptThreads => {
    const previous = Option.getOrUndefined(get.self<KeptThreads>());
    const kept = new Map<EnvironmentId, ReadonlySet<ThreadId>>();
    for (const environmentId of get(input.environmentIdsAtom)) {
      const threadIds = new Set(get(runningThreadIdsAtom(environmentId)));
      for (const threadId of previous?.get(environmentId) ?? []) {
        if (threadIds.has(threadId)) continue;
        const stateAtom = input.stateAtom(environmentId, threadId);
        // A get dependency would hold stopped streams open until another change rebuilds this atom.
        if (isDetailDone(get.once(stateAtom))) continue;
        threadIds.add(threadId);
        get.subscribe(stateAtom, (state) => {
          if (isDetailDone(state)) get.refreshSelf();
        });
      }
      for (const threadId of threadIds) get.mount(input.stateAtom(environmentId, threadId));
      kept.set(environmentId, threadIds);
    }
    return kept;
  }).pipe(Atom.withLabel("web-running-thread-keep-alive"));
}

export const runningThreadKeepAliveAtom = createRunningThreadKeepAliveAtom({
  environmentIdsAtom: Atom.map(environmentCatalog.catalogValueAtom, (catalog) => [
    ...enabledEnvironmentIds(catalog),
  ]),
  threadsAtom: environmentThreadShells.environmentThreadsAtom,
  stateAtom: environmentThreads.stateAtom,
});
