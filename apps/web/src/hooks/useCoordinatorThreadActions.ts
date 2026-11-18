import {
  buildCoordinatorPatch,
  coordinatorThreadIdOf,
} from "@t3tools/client-runtime/coordinator-thread";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function readCoordinatorMenuState(thread: {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null | undefined;
}): { readonly supported: boolean; readonly isCoordinator: boolean } {
  const serverConfig = readEnvironment(thread.environmentId)?.serverConfig ?? null;
  const supported =
    thread.projectId != null &&
    serverConfig?.environment.capabilities.projectSettingsOverrides === true &&
    appAtomRegistry.get(serverEnvironment.updateSettings.permissionAtom(thread.environmentId));
  const isCoordinator =
    coordinatorThreadIdOf(serverConfig?.settings, thread.projectId) === thread.id;
  return { supported, isCoordinator };
}

export function useCoordinatorThreadActions(
  pinThread: (threadRef: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown>>,
) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const updateCoordinator = async (
    threadRef: ScopedThreadRef,
    projectId: ProjectId | null | undefined,
    targetThreadId: ThreadId | null,
    options?: { readonly isPinned?: boolean },
  ) => {
    if (!projectId) return;
    const settings = readEnvironment(threadRef.environmentId)?.serverConfig?.settings;
    if (!settings) {
      failureToast(
        "Failed to update coordinator thread",
        new Error("Server settings are not loaded yet."),
      );
      return;
    }
    const patch = buildCoordinatorPatch(settings, projectId, targetThreadId);
    const result = await updateSettings({
      environmentId: threadRef.environmentId,
      input: { patch },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failureToast("Failed to update coordinator thread", squashAtomCommandFailure(result));
      }
      return;
    }
    if (
      targetThreadId !== null &&
      options?.isPinned !== true &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      const pinResult = await pinThread(threadRef);
      if (pinResult._tag === "Failure" && !isAtomCommandInterrupted(pinResult)) {
        failureToast("Failed to pin thread", squashAtomCommandFailure(pinResult));
      }
    }
  };

  return {
    makeCoordinatorThread: (
      threadRef: ScopedThreadRef,
      projectId: ProjectId | null | undefined,
      isPinned: boolean,
    ) => updateCoordinator(threadRef, projectId, threadRef.threadId, { isPinned }),
    removeCoordinatorThread: (
      threadRef: ScopedThreadRef,
      projectId: ProjectId | null | undefined,
    ) => updateCoordinator(threadRef, projectId, null),
  };
}
