import { isListedThreadLineage, type ThreadId } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { isThreadWorking } from "./state/threadInbox.ts";
import { toSortableTimestamp } from "./state/threadSort.ts";

export const PROJECT_THREAD_BOARD_COLUMNS = [
  "review",
  "waiting",
  "working",
  "idle",
  "done",
] as const;

export type ProjectThreadBoardColumn = (typeof PROJECT_THREAD_BOARD_COLUMNS)[number];

type BoardThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "lastVisitedAt"
  | "updatedAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function projectThreadBoardColumn(thread: BoardThread): ProjectThreadBoardColumn {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  if (thread.pendingSubagentRequest != null) return "waiting";
  if (isThreadWorking(thread)) return "working";
  if (thread.settledOverride === "settled") return "done";
  if (hasUnreviewedCompletion(thread)) return "review";
  return "idle";
}

// Threads a coordinator launches are never opened, so a null watermark counts as unseen.
// `undefined` is an older server without visit tracking; those never read as unreviewed.
function hasUnreviewedCompletion(thread: BoardThread): boolean {
  const run = thread.latestRun;
  if (run?.completedAt == null || thread.lastVisitedAt === undefined) return false;
  if (run.status === "interrupted" || run.status === "cancelled") return false;
  const completedAt = toSortableTimestamp(run.completedAt);
  if (completedAt === null) return false;
  if (thread.lastVisitedAt === null) return true;
  const visitedAt = toSortableTimestamp(thread.lastVisitedAt);
  return visitedAt === null || completedAt > visitedAt;
}

/** A project's listed threads by board column, newest first; coordinators stay off it. */
export function groupProjectThreads<T extends BoardThread>(
  threads: ReadonlyArray<T>,
  options: { readonly coordinatorThreadIds: ReadonlySet<ThreadId> },
): Record<ProjectThreadBoardColumn, T[]> {
  const columns: Record<ProjectThreadBoardColumn, T[]> = {
    review: [],
    waiting: [],
    working: [],
    idle: [],
    done: [],
  };
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (!isListedThreadLineage(thread.lineage) || options.coordinatorThreadIds.has(thread.id)) {
      continue;
    }
    columns[projectThreadBoardColumn(thread)].push(thread);
  }
  for (const column of PROJECT_THREAD_BOARD_COLUMNS) {
    columns[column].sort(
      (a, b) => (toSortableTimestamp(b.updatedAt) ?? 0) - (toSortableTimestamp(a.updatedAt) ?? 0),
    );
  }
  return columns;
}
