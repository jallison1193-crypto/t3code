import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadModeOf } from "@t3tools/client-runtime/state/thread-mode";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  ThreadSectionId,
  type ServerSettings,
  type SidebarModeFilter,
} from "@t3tools/contracts/settings";

type ThreadSections = ServerSettings["threadSections"];

export function threadFolders(sections: ThreadSections) {
  return Object.entries(sections).map(([id, section]) => ({
    ...section,
    id: ThreadSectionId.make(id),
  }));
}

export function currentThreadFolder(sections: ThreadSections, thread: ScopedThreadRef) {
  const key = scopedThreadKey(thread);
  return (
    threadFolders(sections).find(({ members }) =>
      members?.some((member) => scopedThreadKey(member) === key),
    )?.id ?? null
  );
}

export function threadFolderMembershipRequest(
  homeEnvironmentId: EnvironmentId,
  thread: ScopedThreadRef,
  sectionId: ThreadSectionId | null,
) {
  return { environmentId: homeEnvironmentId, input: { homeEnvironmentId, thread, sectionId } };
}

export function threadFolderHomeProblem(
  home:
    | { readonly online: boolean; readonly canEdit: boolean; readonly canAssign: boolean }
    | undefined,
  membership: boolean,
) {
  if (!home?.online) return "offline";
  if (!(membership ? home.canAssign : home.canEdit)) return "read-only";
  return null;
}

export function canChangeThreadFolder(
  current: ThreadSectionId | null,
  destination: ThreadSectionId | null,
  sections: ThreadSections,
  sourceAvailable: boolean,
) {
  return (
    current !== destination &&
    (destination === null || (sourceAvailable && Object.hasOwn(sections, destination)))
  );
}

export function threadFolderPatchApplied(
  settings: Pick<ServerSettings, "threadSections">,
  sectionId: ThreadSectionId,
  name: string | null,
) {
  return (settings.threadSections[sectionId]?.name ?? null) === name;
}

export function resolveThreadFolderMembers<
  Thread extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly deletedAt: string | null;
  } & Parameters<typeof threadModeOf>[0],
>(
  members: readonly ScopedThreadRef[],
  threads: ReadonlyMap<string, Thread>,
  readableSources: ReadonlySet<EnvironmentId>,
  hiddenThreadKeys: ReadonlySet<string>,
  mode: SidebarModeFilter,
) {
  const rows: { ref: ScopedThreadRef; key: string; thread: Thread | null }[] = [];
  for (const ref of members) {
    const key = scopedThreadKey(ref);
    const thread =
      readableSources.has(ref.environmentId) && !hiddenThreadKeys.has(key)
        ? threads.get(key)
        : null;
    if (!thread || thread.deletedAt !== null) {
      if (mode === "all") rows.push({ ref, key, thread: null });
    } else if (mode === "all" || threadModeOf(thread) === mode) {
      rows.push({ ref, key, thread });
    }
  }
  return rows;
}
