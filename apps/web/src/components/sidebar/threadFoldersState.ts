import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { sessionHasScope, environmentSession } from "~/state/session";
import { liveShellEnvironmentIdsAtom } from "~/state/shell";
import { environmentThreadShells } from "~/state/threads";

export const threadFolderHomesAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return [...presentations].flatMap(([id, presentation]) => {
    if (!presentation.serverConfig) return [];
    const label = presentation.entry.target.label;
    const duplicateLabel = [...presentations].some(
      ([otherId, other]) => id !== otherId && other.entry.target.label === label,
    );
    return [
      {
        id,
        label: duplicateLabel ? `${label} (${id})` : label,
        sections: presentation.serverConfig.settings.threadSections,
        online: presentation.connection.phase === "connected",
        canEdit: sessionHasScope(
          get(environmentSession.sessionStateAtom(id)),
          AuthSettingsWriteScope,
        ),
        canAssign: get(serverEnvironment.setThreadSectionMembership.permissionAtom(id)),
      },
    ];
  });
}).pipe(Atom.withLabel("web-thread-folder-homes"));

export const readableThreadFolderSourcesAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return new Set(
    [...get(liveShellEnvironmentIdsAtom)].filter(
      (id) =>
        presentations.get(id)?.connection.phase === "connected" &&
        sessionHasScope(get(environmentSession.sessionStateAtom(id)), AuthOrchestrationReadScope),
    ),
  );
}).pipe(Atom.withLabel("web-readable-thread-folder-sources"));

export function readThreadFolderSource(thread: ScopedThreadRef) {
  if (
    !appAtomRegistry.get(readableThreadFolderSourcesAtom).has(thread.environmentId) ||
    appAtomRegistry.get(environmentThreadShells.hiddenThreadKeysAtom).has(scopedThreadKey(thread))
  )
    return null;
  const shell = readThreadShell(thread);
  return shell?.deletedAt === null ? shell : null;
}
