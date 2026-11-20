import type { AppMode, SidebarModeFilter } from "@t3tools/contracts/settings";

export const WORK_MODE_TAG = "mode:work" as const;

export type ThreadMode = AppMode;

export interface ThreadModeSource {
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly source?:
    | {
        readonly tags?: ReadonlyArray<string> | undefined;
      }
    | undefined;
}

function threadTagsOf(thread: ThreadModeSource): ReadonlyArray<string> {
  return thread.tags ?? thread.source?.tags ?? [];
}

export function threadModeOf(thread: ThreadModeSource): ThreadMode {
  return threadTagsOf(thread).includes(WORK_MODE_TAG) ? "work" : "code";
}

export function filterThreadsByMode<T extends ThreadModeSource>(
  threads: ReadonlyArray<T>,
  filter: SidebarModeFilter,
): ReadonlyArray<T> {
  if (filter === "all") return threads;
  return threads.filter((thread) => threadModeOf(thread) === filter);
}
