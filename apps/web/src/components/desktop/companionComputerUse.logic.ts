import type { OrchestrationV2Run, OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { isComputerUseTool } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";

/** How long computer use counts as going on after its last call. */
export const COMPUTER_USE_HOLD_MS = 8_000;

export interface ThreadComputerUse {
  readonly threadId: ThreadId;
  readonly running: boolean;
  /** Epoch ms of the newest finished call, or 0 with none. */
  readonly lastEndedAt: number;
}

export interface ComputerUsePhase {
  readonly threadId: ThreadId;
  readonly running: boolean;
  readonly waitingOnUser: boolean;
  readonly lastActiveAt: number;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const OPEN_ITEM_STATUSES = new Set(["pending", "running", "waiting"]);

type ToolCallItem = Pick<
  OrchestrationV2TurnItem,
  "type" | "status" | "runId" | "toolSource" | "completedAt" | "startedAt"
> & { readonly toolName?: string | null };

export function threadComputerUse(
  threadId: ThreadId,
  projection: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>;
    readonly turnItems: ReadonlyArray<ToolCallItem>;
  },
): ThreadComputerUse | null {
  const activeRunIds = new Set(
    projection.runs.flatMap((run) => (ACTIVE_RUN_STATUSES.has(run.status) ? [run.id] : [])),
  );
  let running = false;
  let lastEndedAt = 0;
  let used = false;
  for (const item of projection.turnItems) {
    if (item.type !== "dynamic_tool" || !isComputerUseTool(item)) continue;
    if (!OPEN_ITEM_STATUSES.has(item.status)) {
      used = true;
      const endedAt = item.completedAt ?? item.startedAt;
      if (endedAt !== null) lastEndedAt = Math.max(lastEndedAt, DateTime.toEpochMillis(endedAt));
    } else if (item.runId !== null && activeRunIds.has(item.runId)) {
      // An item left open by a run that has ended is stale, not running.
      used = true;
      running = true;
    }
  }
  return used ? { threadId, running, lastEndedAt } : null;
}

/**
 * The computer-use phase after a change, or null when none is going on. A phase starts from a
 * running or just-finished call, and lasts the hold past its end or past a wait for the user.
 */
export function nextComputerUsePhase(input: {
  readonly previous: ComputerUsePhase | null;
  readonly threads: ReadonlyArray<ThreadComputerUse>;
  readonly waitingThreadIds: ReadonlySet<ThreadId>;
  readonly now: number;
}): ComputerUsePhase | null {
  const { previous, threads, waitingThreadIds, now } = input;
  const candidates = threads.map((thread) => ({
    threadId: thread.threadId,
    running: thread.running,
    lastActiveAt: thread.running ? now : thread.lastEndedAt,
  }));
  if (previous !== null) {
    // Its thread may be gone from `threads`, so what was running or waiting ends as of now.
    candidates.push({
      threadId: previous.threadId,
      running: false,
      lastActiveAt: previous.running || previous.waitingOnUser ? now : previous.lastActiveAt,
    });
  }
  const running = candidates.filter((candidate) => candidate.running);
  // Two threads driving the computer at once must not trade places on every update.
  const next =
    running.find((candidate) => candidate.threadId === previous?.threadId) ??
    running[0] ??
    candidates.toSorted((left, right) => right.lastActiveAt - left.lastActiveAt)[0];
  if (next === undefined) return null;
  const waitingOnUser = waitingThreadIds.has(next.threadId);
  if (!next.running && now - next.lastActiveAt >= COMPUTER_USE_HOLD_MS) return null;
  return { ...next, waitingOnUser };
}

/** How long until `phase` can end by time alone, or null while something holds it open. */
export function computerUseHoldRemaining(phase: ComputerUsePhase, now: number): number | null {
  if (phase.running || phase.waitingOnUser) return null;
  return Math.max(0, phase.lastActiveAt + COMPUTER_USE_HOLD_MS - now);
}
