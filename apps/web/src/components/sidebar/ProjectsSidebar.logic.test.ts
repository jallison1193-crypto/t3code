import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectsSidebarSections,
  OTHER_THREADS_LIMIT,
  readExpandedProjectKeys,
  toggleExpandedProjectKey,
  writeExpandedProjectKeys,
  type ProjectsSidebarGroupInput,
  type ProjectsSidebarThread,
} from "./ProjectsSidebar.logic";

const ENV_LOCAL = EnvironmentId.make("env-local");
const ENV_REMOTE = EnvironmentId.make("env-remote");

function completedRun(completedAt: string) {
  return {
    runId: RunId.make("run-1"),
    status: "completed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt,
    assistantMessageId: null,
  };
}

const runningRuntime = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-04-01T00:00:00.000Z",
};

function makeThread(
  id: string,
  overrides: Partial<ProjectsSidebarThread> = {},
): ProjectsSidebarThread {
  const threadId = ThreadId.make(id);
  return {
    environmentId: ENV_LOCAL,
    id: threadId,
    projectId: ProjectId.make("proj-a"),
    title: `Thread ${id}`,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lastVisitedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    pinnedAt: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    ...overrides,
  };
}

function makeGroup(
  projectKey: string,
  displayName: string,
  overrides: Partial<ProjectsSidebarGroupInput> = {},
): ProjectsSidebarGroupInput {
  return {
    projectKey,
    displayName,
    archived: false,
    memberProjects: [{ environmentId: ENV_LOCAL, id: ProjectId.make(projectKey) }],
    ...overrides,
  };
}

const emptyServerSettings = (): Pick<ServerSettings, "projectSettingsOverrides"> | null => null;

describe("buildProjectsSidebarSections", () => {
  it("partitions needsYou across projects and excludes coordinators, archived, deleted, and subagents", () => {
    const coordinatorId = ThreadId.make("coord-a");
    const groups = [makeGroup("proj-a", "Alpha"), makeGroup("proj-b", "Beta")];
    const threads = [
      makeThread("approval", {
        projectId: ProjectId.make("proj-a"),
        hasPendingApprovals: true,
        updatedAt: "2026-04-01T01:00:00.000Z",
      }),
      makeThread("user-input", {
        projectId: ProjectId.make("proj-b"),
        hasPendingUserInput: true,
        updatedAt: "2026-04-01T03:00:00.000Z",
      }),
      makeThread("subagent-req", {
        projectId: ProjectId.make("proj-a"),
        pendingSubagentRequest: "approval",
        updatedAt: "2026-04-01T02:00:00.000Z",
      }),
      makeThread(coordinatorId, {
        projectId: ProjectId.make("proj-a"),
        hasPendingApprovals: true,
      }),
      makeThread("archived", {
        projectId: ProjectId.make("proj-a"),
        hasPendingApprovals: true,
        archivedAt: "2026-04-01T04:00:00.000Z",
      }),
      makeThread("deleted", {
        projectId: ProjectId.make("proj-a"),
        hasPendingApprovals: true,
        deletedAt: "2026-04-01T04:00:00.000Z",
      }),
      makeThread("delegated", {
        projectId: ProjectId.make("proj-a"),
        hasPendingApprovals: true,
        lineage: {
          parentThreadId: ThreadId.make("approval"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("approval"),
        },
      }),
    ];

    const sections = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: () => ({
        projectSettingsOverrides: {
          [ProjectId.make("proj-a")]: { coordinatorThreadId: coordinatorId },
        },
      }),
    });

    expect(sections.needsYou.map((t) => t.id)).toEqual([
      ThreadId.make("user-input"),
      ThreadId.make("subagent-req"),
      ThreadId.make("approval"),
    ]);
  });

  it("skips archived and scratch groups in Projects, keeps only working/waiting under projects, and computes collapsed review/waiting badge", () => {
    const groups = [
      makeGroup("proj-a", "Alpha", {
        memberProjects: [
          { environmentId: ENV_LOCAL, id: ProjectId.make("proj-a-local") },
          { environmentId: ENV_REMOTE, id: ProjectId.make("proj-a-remote") },
        ],
      }),
      makeGroup("proj-review", "ReviewOnly"),
      makeGroup("proj-archived", "ArchivedProject", { archived: true }),
      makeGroup("proj-scratch", "No project", {
        isScratch: true,
        memberProjects: [
          { environmentId: ENV_LOCAL, id: ProjectId.make("proj-scratch"), isScratch: true },
        ],
      }),
    ];

    const threads = [
      makeThread("a-waiting", {
        environmentId: ENV_REMOTE,
        projectId: ProjectId.make("proj-a-remote"),
        hasPendingUserInput: true,
        updatedAt: "2026-04-01T05:00:00.000Z",
      }),
      makeThread("a-working", {
        environmentId: ENV_LOCAL,
        projectId: ProjectId.make("proj-a-local"),
        runtime: runningRuntime,
        updatedAt: "2026-04-01T04:00:00.000Z",
      }),
      makeThread("a-review", {
        environmentId: ENV_LOCAL,
        projectId: ProjectId.make("proj-a-local"),
        lastVisitedAt: "2026-04-01T01:00:00.000Z",
        latestRun: completedRun("2026-04-01T03:00:00.000Z"),
      }),
      makeThread("a-idle", {
        environmentId: ENV_LOCAL,
        projectId: ProjectId.make("proj-a-local"),
      }),
      makeThread("a-done", {
        environmentId: ENV_LOCAL,
        projectId: ProjectId.make("proj-a-local"),
        settledOverride: "settled",
      }),
      makeThread("r-review", {
        projectId: ProjectId.make("proj-review"),
        lastVisitedAt: null,
        latestRun: completedRun("2026-04-01T03:00:00.000Z"),
      }),
      makeThread("archived-proj-thread", {
        projectId: ProjectId.make("proj-archived"),
      }),
      makeThread("scratch-thread", {
        projectId: ProjectId.make("proj-scratch"),
      }),
    ];

    const sections = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: emptyServerSettings,
    });

    expect(sections.projects.map((p) => p.group.projectKey)).toEqual(["proj-a", "proj-review"]);
    expect(sections.projects[0]?.activeThreads.map((t) => t.id)).toEqual([
      ThreadId.make("a-waiting"),
      ThreadId.make("a-working"),
    ]);
    expect(sections.projects[0]?.attentionCount).toBe(2);
    expect(sections.projects[0]?.attentionTone).toBe("waiting");

    expect(sections.projects[1]?.activeThreads).toEqual([]);
    expect(sections.projects[1]?.attentionCount).toBe(1);
    expect(sections.projects[1]?.attentionTone).toBe("review");

    expect(sections.otherThreads.map((t) => t.id)).toEqual([ThreadId.make("scratch-thread")]);
  });

  it("collects pinned threads and caps Other threads at the 10 newest", () => {
    const groups = [makeGroup("proj-a", "Alpha")];
    const threads: ProjectsSidebarThread[] = [
      makeThread("pinned-in-proj", {
        projectId: ProjectId.make("proj-a"),
        pinnedAt: "2026-04-01T10:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00.000Z",
      }),
      ...Array.from({ length: OTHER_THREADS_LIMIT + 3 }, (_, index) =>
        makeThread(`orphan-${String(index).padStart(2, "0")}`, {
          projectId: ProjectId.make("orphan-project"),
          updatedAt: `2026-04-01T${String(index).padStart(2, "0")}:00:00.000Z`,
        }),
      ),
    ];

    const sections = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: emptyServerSettings,
    });

    expect(sections.pinned.map((t) => t.id)).toEqual([ThreadId.make("pinned-in-proj")]);
    expect(sections.otherThreads).toHaveLength(OTHER_THREADS_LIMIT);
    expect(sections.otherThreads[0]?.id).toBe(ThreadId.make("orphan-12"));
    expect(sections.otherThreads[OTHER_THREADS_LIMIT - 1]?.id).toBe(ThreadId.make("orphan-03"));
  });
});

describe("expanded project persistence", () => {
  it("reads, toggles, and writes expanded project keys safely", () => {
    let saved = "";
    const memoryStorage = {
      getItem: () => saved || null,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };

    expect(readExpandedProjectKeys(memoryStorage)).toEqual({});
    const next = toggleExpandedProjectKey({}, "proj-a");
    writeExpandedProjectKeys(next, memoryStorage);
    expect(readExpandedProjectKeys(memoryStorage)).toEqual({ "proj-a": true });
    expect(toggleExpandedProjectKey(next, "proj-a")).toEqual({ "proj-a": false });
  });

  it("handles malformed or throwing storage without crashing", () => {
    expect(
      readExpandedProjectKeys({
        getItem: () => "{not valid json",
      }),
    ).toEqual({});
    expect(
      readExpandedProjectKeys({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toEqual({});
    expect(() =>
      writeExpandedProjectKeys(
        { "proj-a": true },
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
      ),
    ).not.toThrow();
  });
});

describe("buildProjectsSidebarSections mode filtering", () => {
  it("filters every section by mode except Needs you", () => {
    const groups = [makeGroup("proj-a", "Alpha")];
    const threads: ProjectsSidebarThread[] = [
      makeThread("code-waiting", {
        projectId: ProjectId.make("proj-a"),
        hasPendingApprovals: true,
        source: { tags: [] },
      }),
      makeThread("work-waiting", {
        projectId: ProjectId.make("proj-a"),
        hasPendingUserInput: true,
        pinnedAt: "2026-04-01T09:00:00.000Z",
        source: { tags: ["mode:work"] },
      }),
      makeThread("work-orphan", {
        projectId: ProjectId.make("orphan-project"),
        tags: ["mode:work"],
      }),
    ];

    const defaultSections = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: emptyServerSettings,
    });
    expect(defaultSections.needsYou.map((t) => t.id)).toEqual([
      ThreadId.make("code-waiting"),
      ThreadId.make("work-waiting"),
    ]);
    expect(defaultSections.projects[0]?.activeThreads.map((t) => t.id)).toEqual([
      ThreadId.make("code-waiting"),
      ThreadId.make("work-waiting"),
    ]);
    expect(defaultSections.projects[0]?.attentionCount).toBe(2);
    expect(defaultSections.projects[0]?.attentionTone).toBe("waiting");

    const workSections = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: emptyServerSettings,
      modeFilter: "work",
    });
    expect(workSections.needsYou.map((t) => t.id)).toEqual([
      ThreadId.make("code-waiting"),
      ThreadId.make("work-waiting"),
    ]);
    expect(workSections.projects[0]?.activeThreads.map((t) => t.id)).toEqual([
      ThreadId.make("work-waiting"),
    ]);
    expect(workSections.projects[0]?.attentionCount).toBe(1);
    expect(workSections.projects[0]?.attentionTone).toBe("waiting");
    expect(workSections.pinned.map((t) => t.id)).toEqual([ThreadId.make("work-waiting")]);
    expect(workSections.otherThreads.map((t) => t.id)).toEqual([ThreadId.make("work-orphan")]);

    const codeSections = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: emptyServerSettings,
      modeFilter: "code",
    });
    expect(codeSections.needsYou.map((t) => t.id)).toEqual([
      ThreadId.make("code-waiting"),
      ThreadId.make("work-waiting"),
    ]);
    expect(codeSections.projects[0]?.activeThreads.map((t) => t.id)).toEqual([
      ThreadId.make("code-waiting"),
    ]);
    expect(codeSections.projects[0]?.attentionCount).toBe(1);
    expect(codeSections.projects[0]?.attentionTone).toBe("waiting");
    expect(codeSections.pinned).toEqual([]);
    expect(codeSections.otherThreads).toEqual([]);
  });
});
