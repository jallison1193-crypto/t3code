import { groupProjectBoardThreadsForMembers } from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadBoardSections,
  isProjectCoordinatorThread,
  resolveProjectCoordinatorTarget,
  resolveProjectThreadsTarget,
} from "./projectThreads.logic";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const PROJECT_A = ProjectId.make("proj-a");
const PROJECT_B = ProjectId.make("proj-b");
const THREAD_COORDINATOR = ThreadId.make("thread-coord");
const THREAD_REVIEW = ThreadId.make("thread-review");
const THREAD_WAITING = ThreadId.make("thread-waiting");
const THREAD_WORKING = ThreadId.make("thread-working");
const THREAD_DONE = ThreadId.make("thread-done");
const THREAD_DELETED = ThreadId.make("thread-deleted");

type BoardThreadFixture = Parameters<typeof groupProjectBoardThreadsForMembers>[0][number] & {
  readonly title: string;
};

function makeProject(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    environmentId: ENV_A,
    id: PROJECT_A,
    title: "T3 Code",
    workspaceRoot: "/Users/dev/t3code",
    repositoryIdentity: {
      canonicalKey: "github:pingdotgg/t3code",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/pingdotgg/t3code.git",
      },
      rootPath: "/Users/dev/t3code",
      provider: SourceControlProviderKind.make("github"),
      owner: "pingdotgg",
      name: "t3code",
      displayName: "pingdotgg/t3code",
    },
    defaultModelSelection: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<BoardThreadFixture> = {}): BoardThreadFixture {
  const id = overrides.id ?? THREAD_REVIEW;
  return {
    environmentId: ENV_A,
    id,
    projectId: PROJECT_A,
    title: "Thread",
    interactionMode: "default",
    latestRun: {
      runId: RunId.make("run-1"),
      status: "completed",
      requestedAt: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
      assistantMessageId: null,
    },
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    hasActionableProposedPlan: false,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    lastVisitedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    updatedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

function settingsWithCoordinator(
  projectId: ProjectId,
  threadId: ThreadId,
): Pick<ServerSettings, "projectSettingsOverrides"> {
  return {
    projectSettingsOverrides: {
      [projectId]: {
        coordinatorThreadId: threadId,
      },
    },
  };
}

describe("resolveProjectThreadsTarget", () => {
  const grouping = {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  };
  const projectA = makeProject({ environmentId: ENV_A, id: PROJECT_A, title: "t3code" });
  const projectB = makeProject({ environmentId: ENV_B, id: PROJECT_B, title: "t3code" });

  it("resolves a grouped project by member environmentId and projectId", () => {
    const resolved = resolveProjectThreadsTarget([projectA, projectB], grouping, {
      environmentId: ENV_B,
      projectId: PROJECT_B,
    });
    expect(resolved?.members).toHaveLength(2);
    expect(resolved?.displayName).toBe("pingdotgg/t3code");
  });

  it("resolves a grouped project by projectKey", () => {
    const first = resolveProjectThreadsTarget([projectA, projectB], grouping, {
      environmentId: ENV_A,
      projectId: PROJECT_A,
    });
    const resolved = resolveProjectThreadsTarget([projectA, projectB], grouping, {
      projectKey: first?.groupKey,
    });
    expect(resolved?.groupKey).toBe(first?.groupKey);
    expect(resolved?.members).toEqual([projectA, projectB]);
  });

  it("returns null when no matching project exists", () => {
    expect(resolveProjectThreadsTarget([projectA], grouping, { projectKey: "missing" })).toBeNull();
  });
});

describe("buildProjectThreadBoardSections", () => {
  it("keeps canonical column order, hides empty columns, and marks Done collapsed by default", () => {
    const settings = settingsWithCoordinator(PROJECT_A, THREAD_COORDINATOR);
    const columns = groupProjectBoardThreadsForMembers(
      [
        makeThread({ id: THREAD_COORDINATOR }),
        makeThread({ id: THREAD_REVIEW }),
        makeThread({ id: THREAD_WAITING, hasPendingApprovals: true }),
        makeThread({
          id: THREAD_WORKING,
          runtime: {
            status: "running",
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
        }),
        makeThread({ id: THREAD_DONE, settledOverride: "settled" }),
      ],
      [{ environmentId: ENV_A, id: PROJECT_A }],
      () => settings,
    );

    const sections = buildProjectThreadBoardSections(columns);
    expect(sections.map((section) => section.column)).toEqual([
      "review",
      "waiting",
      "working",
      "done",
    ]);
    expect(sections.map((section) => section.count)).toEqual([1, 1, 1, 1]);
    expect(sections.map((section) => section.defaultCollapsed)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("coordinator helpers", () => {
  it("resolves the first live coordinator thread across project members", () => {
    const target = resolveProjectCoordinatorTarget(
      [
        { environmentId: ENV_A, id: PROJECT_A },
        { environmentId: ENV_B, id: PROJECT_B },
      ],
      (environmentId) =>
        environmentId === ENV_B
          ? settingsWithCoordinator(PROJECT_B, THREAD_COORDINATOR)
          : undefined,
      [
        makeThread({
          environmentId: ENV_B,
          id: THREAD_COORDINATOR,
          projectId: PROJECT_B,
          title: "Coordinator",
        }),
      ],
    );
    expect(target).toEqual({
      environmentId: ENV_B,
      threadId: THREAD_COORDINATOR,
      title: "Coordinator",
    });
  });

  it("returns null when the configured coordinator thread is deleted", () => {
    const target = resolveProjectCoordinatorTarget(
      [{ environmentId: ENV_A, id: PROJECT_A }],
      () => settingsWithCoordinator(PROJECT_A, THREAD_DELETED),
      [
        makeThread({
          environmentId: ENV_A,
          id: THREAD_DELETED,
          deletedAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
    );
    expect(target).toBeNull();
  });

  it("identifies whether a thread is its project's coordinator", () => {
    const settings = settingsWithCoordinator(PROJECT_A, THREAD_COORDINATOR);
    expect(
      isProjectCoordinatorThread({ id: THREAD_COORDINATOR, projectId: PROJECT_A }, settings),
    ).toBe(true);
    expect(isProjectCoordinatorThread({ id: THREAD_REVIEW, projectId: PROJECT_A }, settings)).toBe(
      false,
    );
    expect(isProjectCoordinatorThread(null, settings)).toBe(false);
  });
});
