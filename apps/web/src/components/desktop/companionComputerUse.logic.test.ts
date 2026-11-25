import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPUTER_USE_HOLD_MS,
  type ComputerUsePhase,
  computerUseHoldRemaining,
  nextComputerUsePhase,
  type ThreadComputerUse,
  threadComputerUse,
} from "./companionComputerUse.logic";

const A = ThreadId.make("a");
const B = ThreadId.make("b");
const NOW = 1_000_000;
const NOBODY: ReadonlySet<ThreadId> = new Set();

const used = (threadId: ThreadId, running: boolean, lastEndedAt = 0): ThreadComputerUse => ({
  threadId,
  running,
  lastEndedAt,
});

function step(
  previous: ComputerUsePhase | null,
  threads: ReadonlyArray<ThreadComputerUse>,
  now: number,
  waitingThreadIds = NOBODY,
) {
  return nextComputerUsePhase({ previous, threads, waitingThreadIds, now });
}

describe("companion computer-use phase", () => {
  it("holds for a while after the last call, even once the thread is gone", () => {
    const running = step(null, [used(A, true)], NOW);
    expect(running).toMatchObject({ threadId: A, running: true });
    expect(computerUseHoldRemaining(running!, NOW)).toBeNull();

    const ended = step(running, [], NOW + 60_000);
    expect(ended).toMatchObject({ threadId: A, running: false });
    expect(computerUseHoldRemaining(ended!, NOW + 61_000)).toBe(COMPUTER_USE_HOLD_MS - 1_000);
    expect(step(ended, [], NOW + 60_000 + COMPUTER_USE_HOLD_MS - 1)).not.toBeNull();
    expect(step(ended, [], NOW + 60_000 + COMPUTER_USE_HOLD_MS)).toBeNull();
  });

  it("starts from a call that just finished and not from old history", () => {
    expect(step(null, [used(A, false, NOW - 100)], NOW)).toMatchObject({ threadId: A });
    expect(step(null, [used(A, false, NOW - COMPUTER_USE_HOLD_MS)], NOW)).toBeNull();
    expect(step(null, [used(A, false, NOW - 60_000)], NOW, new Set([A]))).toBeNull();
  });

  it("stays on its thread while that one runs, else follows the running one", () => {
    const first = step(null, [used(A, true)], NOW);
    const both = step(first, [used(B, true), used(A, true)], NOW);
    expect(both).toMatchObject({ threadId: A });
    expect(step(both, [used(A, false, NOW), used(B, true)], NOW)).toMatchObject({ threadId: B });
  });

  it("does not end while its thread waits for the user", () => {
    const waiting = step(step(null, [used(A, true)], NOW), [], NOW, new Set([A]));
    expect(waiting).toMatchObject({ waitingOnUser: true });
    expect(computerUseHoldRemaining(waiting!, NOW)).toBeNull();
    const later = step(waiting, [], NOW + 60_000, new Set([A]));
    expect(later).toMatchObject({ waitingOnUser: true });
    expect(step(later, [], NOW + 90_000)).toMatchObject({
      waitingOnUser: false,
      lastActiveAt: NOW + 90_000,
    });
  });
});

describe("a thread's computer use", () => {
  const run = RunId.make("run");
  const ended = RunId.make("ended");
  const item = (
    toolName: string,
    status: "running" | "completed",
    runId: RunId,
  ): Parameters<typeof threadComputerUse>[1]["turnItems"][number] => ({
    type: "dynamic_tool",
    toolName,
    status,
    runId,
    startedAt: DateTime.makeUnsafe(NOW),
    completedAt: status === "completed" ? DateTime.makeUnsafe(NOW) : null,
  });
  const read = (...turnItems: ReadonlyArray<ReturnType<typeof item>>) =>
    threadComputerUse(A, {
      runs: [
        { id: run, status: "running" },
        { id: ended, status: "completed" },
      ],
      turnItems,
    });

  it("counts open calls of a live run and finished calls, and nothing else", () => {
    expect(read(item("Bash", "running", run))).toBeNull();
    expect(read(item("computer", "running", ended))).toBeNull();
    expect(read(item("computer", "running", run))).toEqual(used(A, true));
    expect(read(item("computer", "completed", ended))).toEqual(used(A, false, NOW));
  });
});
