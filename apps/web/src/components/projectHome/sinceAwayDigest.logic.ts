import { hasUnseenRunFailure } from "@t3tools/client-runtime/state/thread-settled";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

export type SinceAwayDigestThread = Parameters<typeof hasUnseenCompletion>[0] &
  Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof hasUnseenRunFailure>[0];

export interface SinceAwayDigest<T> {
  readonly needsYou: readonly T[];
  readonly failed: readonly T[];
  readonly finished: readonly T[];
}

export function buildSinceAwayDigest<T extends SinceAwayDigestThread>(
  threads: readonly T[],
): SinceAwayDigest<T> {
  const needsYou: T[] = [];
  const failed: T[] = [];
  const finished: T[] = [];

  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "approval" || status === "input" || status === "request") {
      needsYou.push(thread);
    } else if (
      (status === "failed" || status === "limited" || status === "ready") &&
      hasUnseenRunFailure(thread)
    ) {
      failed.push(thread);
    } else if (
      status === "ready" &&
      thread.latestRun?.status !== "failed" &&
      hasUnseenCompletion(thread)
    ) {
      finished.push(thread);
    }
  }

  return { needsYou, failed, finished };
}

export function sinceAwayDigestCount(digest: SinceAwayDigest<unknown>): number {
  return digest.needsYou.length + digest.failed.length + digest.finished.length;
}
