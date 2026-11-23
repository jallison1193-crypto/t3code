import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSinceAwayDigest,
  sinceAwayDigestCount,
  type SinceAwayDigestThread,
} from "./sinceAwayDigest.logic";

const COMPLETED_AT = "2026-03-09T10:05:00.000Z";
const BEFORE_COMPLETE = "2026-03-09T10:04:00.000Z";
const AFTER_COMPLETE = "2026-03-09T10:06:00.000Z";

function makeLatestRun(
  overrides?: Partial<NonNullable<SinceAwayDigestThread["latestRun"]>>,
): NonNullable<SinceAwayDigestThread["latestRun"]> {
  return {
    runId: RunId.make("run-1"),
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

function makeRuntime(
  overrides?: Partial<NonNullable<SinceAwayDigestThread["runtime"]>>,
): NonNullable<SinceAwayDigestThread["runtime"]> {
  return {
    status: "completed",
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: COMPLETED_AT,
    ...overrides,
  };
}

function makeThread(
  id: string,
  overrides?: Partial<SinceAwayDigestThread>,
): SinceAwayDigestThread & { readonly id: string } {
  return {
    id,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    latestRun: makeLatestRun(),
    runtime: makeRuntime(),
    lastVisitedAt: AFTER_COMPLETE,
    ...overrides,
  };
}

describe("buildSinceAwayDigest", () => {
  it("returns empty groups for empty input", () => {
    const digest = buildSinceAwayDigest([]);
    expect(digest).toEqual({ needsYou: [], failed: [], finished: [] });
    expect(sinceAwayDigestCount(digest)).toBe(0);
  });

  it("groups waiting, unseen failed (including usage-limit), and unseen finished threads", () => {
    const approval = makeThread("approval", { hasPendingApprovals: true });
    const input = makeThread("input", { hasPendingUserInput: true });
    const subagentApproval = makeThread("subagent-approval", {
      pendingSubagentRequest: "approval",
    });
    const guest = makeThread("guest", { pendingGuestMessageCount: 1 });
    const failed = makeThread("failed", {
      runtime: makeRuntime({ status: "failed", lastError: "Boom" }),
      latestRun: makeLatestRun({ status: "failed" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const limited = makeThread("limited", {
      runtime: makeRuntime({
        status: "failed",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
      }),
      latestRun: makeLatestRun({ status: "failed" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const finished = makeThread("finished", { lastVisitedAt: BEFORE_COMPLETE });
    const neverOpened = makeThread("never-opened", { lastVisitedAt: null });

    const digest = buildSinceAwayDigest([
      approval,
      input,
      subagentApproval,
      guest,
      failed,
      limited,
      finished,
      neverOpened,
    ]);

    expect(digest.needsYou.map((thread) => thread.id)).toEqual([
      "approval",
      "input",
      "subagent-approval",
      "guest",
    ]);
    expect(digest.failed.map((thread) => thread.id)).toEqual(["failed", "limited"]);
    expect(digest.finished.map((thread) => thread.id)).toEqual(["finished", "never-opened"]);
    expect(sinceAwayDigestCount(digest)).toBe(8);
  });

  it("places each thread in at most one group with priority needsYou > failed > finished", () => {
    const needsYouAndFailed = makeThread("needs-you-and-failed", {
      hasPendingApprovals: true,
      runtime: makeRuntime({ status: "failed", lastError: "Boom" }),
      latestRun: makeLatestRun({ status: "failed" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const guestAndFinished = makeThread("guest-and-finished", {
      pendingGuestMessageCount: 2,
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const failedWithCompletedAt = makeThread("failed-with-completed-at", {
      runtime: makeRuntime({ status: "failed", lastError: "Boom" }),
      latestRun: makeLatestRun({ status: "failed", completedAt: COMPLETED_AT }),
      lastVisitedAt: BEFORE_COMPLETE,
    });

    const digest = buildSinceAwayDigest([
      needsYouAndFailed,
      guestAndFinished,
      failedWithCompletedAt,
    ]);

    expect(digest.needsYou.map((thread) => thread.id)).toEqual([
      "needs-you-and-failed",
      "guest-and-finished",
    ]);
    expect(digest.failed.map((thread) => thread.id)).toEqual(["failed-with-completed-at"]);
    expect(digest.finished).toEqual([]);
  });

  it("excludes seen completions, seen failures, interrupted/cancelled runs, and active work", () => {
    const seenFinished = makeThread("seen-finished", { lastVisitedAt: AFTER_COMPLETE });
    const seenFailed = makeThread("seen-failed", {
      runtime: makeRuntime({ status: "failed", lastError: "Boom" }),
      latestRun: makeLatestRun({ status: "failed" }),
      lastVisitedAt: AFTER_COMPLETE,
    });
    const seenLimited = makeThread("seen-limited", {
      runtime: makeRuntime({
        status: "failed",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
      }),
      latestRun: makeLatestRun({ status: "failed" }),
      lastVisitedAt: AFTER_COMPLETE,
    });
    const interrupted = makeThread("interrupted", {
      runtime: makeRuntime({ status: "interrupted" }),
      latestRun: makeLatestRun({ status: "interrupted" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const cancelled = makeThread("cancelled", {
      runtime: makeRuntime({ status: "cancelled" }),
      latestRun: makeLatestRun({ status: "cancelled" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const working = makeThread("working", {
      runtime: makeRuntime({ status: "running" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });
    const waitingOnBackground = makeThread("waiting-bg", {
      runtime: makeRuntime({ status: "idle" }),
      lastVisitedAt: BEFORE_COMPLETE,
    });

    const digest = buildSinceAwayDigest([
      seenFinished,
      seenFailed,
      seenLimited,
      interrupted,
      cancelled,
      working,
      waitingOnBackground,
    ]);

    expect(digest).toEqual({ needsYou: [], failed: [], finished: [] });
  });
});
