import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import type { OrchestrationV2ThreadShell, ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";

/**
 * From a project's coordinator, a related thread opens beside it instead of replacing it.
 * Returns false when `fromRef` is not a coordinator, or the target opens elsewhere.
 */
export function openThreadBesideCoordinator(
  fromRef: ScopedThreadRef,
  fromProjectId: ProjectId | null | undefined,
  targetRef: ScopedThreadRef,
  target: Pick<OrchestrationV2ThreadShell, "lineage"> | null,
): boolean {
  if (
    targetRef.environmentId !== fromRef.environmentId ||
    targetRef.threadId === fromRef.threadId ||
    target?.lineage.sideChat === true
  ) {
    return false;
  }
  const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(fromRef.environmentId));
  if (coordinatorThreadIdOf(settings, fromProjectId) !== fromRef.threadId) return false;
  useRightPanelStore.getState().openThread(fromRef, targetRef.threadId, "thread");
  return true;
}
