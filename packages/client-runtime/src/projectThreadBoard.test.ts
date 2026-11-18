import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupProjectThreads, projectThreadBoardColumn } from "./projectThreadBoard.ts";

type Overrides = Partial<Parameters<typeof projectThreadBoardColumn>[0]>;

function thread(id: string, overrides: Overrides = {}) {
  return {
    id: ThreadId.make(id),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lastVisitedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default" as const,
    latestRun: null,
    runtime: null,
    ...overrides,
  };
}

function withoutVisitTracking<T extends { lastVisitedAt?: string | null }>(input: T) {
  const { lastVisitedAt: _lastVisitedAt, ...rest } = input;
  return rest;
}

function completedRun(completedAt: string, status: "completed" | "interrupted" = "completed") {
  return {
    runId: RunId.make("run-1"),
    status,
    requestedAt: null,
    startedAt: null,
    completedAt,
    assistantMessageId: null,
  };
}

const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-06-01T00:00:00.000Z",
};

describe("projectThreadBoardColumn", () => {
  it.each([
    ["approval wait", thread("a", { hasPendingApprovals: true, runtime: running }), "waiting"],
    ["user input wait", thread("a", { hasPendingUserInput: true }), "waiting"],
    ["running turn", thread("a", { runtime: running }), "working"],
    ["settled", thread("a", { settledOverride: "settled" }), "done"],
    [
      "finished after the last visit",
      thread("a", { latestRun: completedRun("2026-06-02T00:00:00.000Z") }),
      "review",
    ],
    [
      "finished and never opened",
      thread("a", { lastVisitedAt: null, latestRun: completedRun("2026-06-02T00:00:00.000Z") }),
      "review",
    ],
    [
      "finished before the last visit",
      thread("a", {
        lastVisitedAt: "2026-06-03T00:00:00.000Z",
        latestRun: completedRun("2026-06-02T00:00:00.000Z"),
      }),
      "idle",
    ],
    [
      "interrupted",
      thread("a", { latestRun: completedRun("2026-06-02T00:00:00.000Z", "interrupted") }),
      "idle",
    ],
    [
      "server without visit tracking",
      withoutVisitTracking(thread("a", { latestRun: completedRun("2026-06-02T00:00:00.000Z") })),
      "idle",
    ],
    ["never run", thread("a"), "idle"],
  ] as const)("%s", (_name, input, column) => {
    expect(projectThreadBoardColumn(input)).toBe(column);
  });
});

describe("groupProjectThreads", () => {
  it("leaves off the coordinator, side chats, subagents, archived and deleted threads", () => {
    const columns = groupProjectThreads(
      [
        thread("coordinator"),
        thread("kept"),
        thread("side", {
          lineage: {
            parentThreadId: ThreadId.make("kept"),
            relationshipToParent: null,
            rootThreadId: ThreadId.make("kept"),
            sideChat: true,
          },
        }),
        thread("sub", {
          lineage: {
            parentThreadId: ThreadId.make("kept"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("kept"),
          },
        }),
        thread("archived", { archivedAt: "2026-06-01T00:00:00.000Z" }),
        thread("deleted", { deletedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      { coordinatorThreadIds: new Set([ThreadId.make("coordinator")]) },
    );
    expect(
      Object.values(columns)
        .flat()
        .map((t) => t.id),
    ).toEqual(["kept"]);
  });

  it("orders each column newest first", () => {
    const columns = groupProjectThreads(
      [
        thread("old", { updatedAt: "2026-06-01T00:00:00.000Z" }),
        thread("new", { updatedAt: "2026-06-05T00:00:00.000Z" }),
      ],
      { coordinatorThreadIds: new Set() },
    );
    expect(columns.idle.map((t) => t.id)).toEqual(["new", "old"]);
  });
});
