import { useAtomValue } from "@effect/atom-react";
import {
  buildCoordinatorPatch,
  coordinatorThreadIdOf,
} from "@t3tools/client-runtime/coordinator-thread";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useCallback, useMemo } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const projectCoordinatorThreadIdFamily = Atom.family((key: string) => {
  const separator = key.indexOf("\0");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const projectId = key.slice(separator + 1) as ProjectId;
  return Atom.make((get) => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    return coordinatorThreadIdOf(config?.settings, projectId);
  });
});

const environmentCoordinatorSupportedFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    const canWriteSettings = get(serverEnvironment.updateSettings.permissionAtom(environmentId));
    return config?.environment.capabilities.projectSettingsOverrides === true && canWriteSettings;
  }),
);

export function useCoordinatorThreadRowAction(
  thread: EnvironmentThreadShell,
  onPinThread: (thread: EnvironmentThreadShell) => void,
) {
  const gt = useGT();
  const coordinatorThreadId = useAtomValue(
    projectCoordinatorThreadIdFamily(`${thread.environmentId}\0${thread.projectId}`),
  );
  const coordinatorSupported = useAtomValue(
    environmentCoordinatorSupportedFamily(thread.environmentId),
  );
  const isCoordinator = coordinatorThreadId === thread.id;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "coordinator thread update",
    reportFailure: false,
  });

  const coordinatorMenuItems = useMemo<MenuAction[]>(() => {
    if (!coordinatorSupported || !thread.projectId) return [];
    return [
      isCoordinator
        ? { id: "remove-coordinator", title: gt("Remove as coordinator"), image: "cpu" }
        : { id: "make-coordinator", title: gt("Make project coordinator"), image: "cpu" },
    ];
  }, [coordinatorSupported, gt, isCoordinator, thread.projectId]);

  const handleCoordinatorMenuAction = useCallback(
    (eventId: string) => {
      if (eventId !== "make-coordinator" && eventId !== "remove-coordinator") return false;
      const targetThreadId = eventId === "make-coordinator" ? thread.id : null;
      const settings = appAtomRegistry.get(
        serverEnvironment.configValueAtom(thread.environmentId),
      )?.settings;
      if (!settings) {
        Dialog.alert(
          gt("Could not update coordinator thread"),
          gt("Server settings are not loaded yet."),
        );
        return true;
      }
      const patch = buildCoordinatorPatch(settings, thread.projectId, targetThreadId);
      void (async () => {
        const result = await updateSettings({
          environmentId: thread.environmentId,
          input: { patch },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Dialog.alert(
              gt("Could not update coordinator thread"),
              error instanceof Error ? error.message : gt("Try again."),
            );
          }
          return;
        }
        if (
          targetThreadId !== null &&
          thread.pinnedAt == null &&
          readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
        ) {
          onPinThread(thread);
        }
      })();
      return true;
    },
    [gt, onPinThread, thread, updateSettings],
  );

  return { isCoordinator, coordinatorMenuItems, handleCoordinatorMenuAction };
}
