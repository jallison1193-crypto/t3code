import {
  EnvironmentId,
  ProjectId,
  resolveSidebarModeFilter,
  ThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectsSidebarSections,
  type ProjectsSidebarGroupInput,
  type ProjectsSidebarThread,
} from "../components/sidebar/ProjectsSidebar.logic";
import {
  deriveBotSidebarEntries,
  filterNonBotProjects,
  filterNonBotThreads,
  isAnyBotsEnabled,
} from "./bots.logic";

const ENV_LOCAL = EnvironmentId.make("env-local");
const ORDINARY_PROJECT = ProjectId.make("project-ordinary");
const BOT_PROJECT = ProjectId.make("project-bot");
const PAUSED_BOT_PROJECT = ProjectId.make("project-bot-paused");

function makeThread(
  id: string,
  overrides: Partial<ProjectsSidebarThread> = {},
): ProjectsSidebarThread {
  const threadId = ThreadId.make(id);
  return {
    environmentId: ENV_LOCAL,
    id: threadId,
    projectId: ORDINARY_PROJECT,
    title: `Thread ${id}`,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lastVisitedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
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

function makeGroup(projectId: ProjectId, displayName: string): ProjectsSidebarGroupInput {
  return {
    projectKey: `${ENV_LOCAL}:${projectId}`,
    displayName,
    archived: false,
    memberProjects: [{ environmentId: ENV_LOCAL, id: projectId }],
  };
}

function makeSettings(
  botsEnabled: boolean,
): Pick<ServerSettings, "botsEnabled" | "projectSettingsOverrides"> {
  return {
    botsEnabled,
    projectSettingsOverrides: {
      [BOT_PROJECT]: { bot: {} },
      [PAUSED_BOT_PROJECT]: { bot: { paused: true } },
    },
  };
}

describe("bots client logic", () => {
  it("filters bot projects and threads out of All, Code, and Work while keeping waiting bot threads in Needs you only when bots are on", () => {
    const groups = [
      makeGroup(ORDINARY_PROJECT, "App"),
      makeGroup(BOT_PROJECT, "PR Digest"),
      makeGroup(PAUSED_BOT_PROJECT, "Triage Bot"),
    ];
    const ordinaryWaiting = makeThread("ord-waiting", {
      projectId: ORDINARY_PROJECT,
      hasPendingApprovals: true,
      updatedAt: "2026-10-01T01:00:00.000Z",
    });
    const botWaiting = makeThread("bot-waiting", {
      projectId: BOT_PROJECT,
      hasPendingUserInput: true,
      pinnedAt: "2026-10-01T01:00:00.000Z",
      updatedAt: "2026-10-01T02:00:00.000Z",
    });
    const botIdle = makeThread("bot-idle", {
      projectId: BOT_PROJECT,
      updatedAt: "2026-10-01T03:00:00.000Z",
    });
    const ordinaryPinned = makeThread("ord-pinned", {
      projectId: ORDINARY_PROJECT,
      pinnedAt: "2026-10-01T01:00:00.000Z",
      tags: ["mode:work"],
      updatedAt: "2026-10-01T00:30:00.000Z",
    });
    const threads = [ordinaryWaiting, botWaiting, botIdle, ordinaryPinned];

    for (const modeFilter of ["all", "code", "work"] as const) {
      const sections = buildProjectsSidebarSections({
        projectGroups: groups,
        threads,
        getServerSettings: () => makeSettings(true),
        modeFilter,
      });
      expect(sections.projects.map((entry) => entry.group.displayName)).toEqual(["App"]);
      expect(sections.pinned.map((t) => t.id)).not.toContain(botWaiting.id);
      expect(sections.otherThreads.map((t) => t.id)).not.toContain(botIdle.id);
      expect(sections.needsYou.map((t) => t.id)).toEqual([botWaiting.id, ordinaryWaiting.id]);
    }

    // When bots are off, waiting bot threads are hidden from Needs you too.
    const sectionsOff = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: () => makeSettings(false),
      modeFilter: "all",
    });
    expect(sectionsOff.projects.map((entry) => entry.group.displayName)).toEqual(["App"]);
    expect(sectionsOff.needsYou.map((t) => t.id)).toEqual([ordinaryWaiting.id]);
    expect(sectionsOff.pinned.map((t) => t.id)).toEqual([ordinaryPinned.id]);
    expect(sectionsOff.otherThreads).toEqual([]);
  });

  it("derives bot sidebar entries with paused state and runs only when bots are enabled", () => {
    const groups = [
      makeGroup(ORDINARY_PROJECT, "App"),
      makeGroup(BOT_PROJECT, "PR Digest"),
      makeGroup(PAUSED_BOT_PROJECT, "Alert Bot"),
    ];
    const botRunNew = makeThread("bot-run-new", {
      projectId: BOT_PROJECT,
      updatedAt: "2026-10-01T05:00:00.000Z",
    });
    const botRunOld = makeThread("bot-run-old", {
      projectId: BOT_PROJECT,
      updatedAt: "2026-10-01T01:00:00.000Z",
    });
    const threads = [botRunOld, botRunNew];

    const entries = deriveBotSidebarEntries({
      projectGroups: groups,
      threads,
      getServerSettings: () => makeSettings(true),
    });
    expect(entries.map((entry) => ({ name: entry.name, paused: entry.paused }))).toEqual([
      { name: "Alert Bot", paused: true },
      { name: "PR Digest", paused: false },
    ]);
    expect(entries[1]?.runThreads.map((t) => t.id)).toEqual([botRunNew.id, botRunOld.id]);

    expect(
      deriveBotSidebarEntries({
        projectGroups: groups,
        threads,
        getServerSettings: () => makeSettings(false),
      }),
    ).toEqual([]);
  });

  it("filters bot projects and threads cleanly and resolves bots sidebar mode fallback", () => {
    const getSettings = () => makeSettings(true);
    expect(
      filterNonBotProjects(
        [
          { environmentId: ENV_LOCAL, id: ORDINARY_PROJECT },
          { environmentId: ENV_LOCAL, id: BOT_PROJECT },
        ],
        getSettings,
      ),
    ).toEqual([{ environmentId: ENV_LOCAL, id: ORDINARY_PROJECT }]);

    expect(
      filterNonBotThreads(
        [
          { environmentId: ENV_LOCAL, projectId: ORDINARY_PROJECT, id: "1" },
          { environmentId: ENV_LOCAL, projectId: BOT_PROJECT, id: "2" },
        ],
        getSettings,
      ),
    ).toEqual([{ environmentId: ENV_LOCAL, projectId: ORDINARY_PROJECT, id: "1" }]);

    expect(isAnyBotsEnabled([{ serverConfig: { settings: { botsEnabled: true } } }])).toBe(true);
    expect(isAnyBotsEnabled([{ serverConfig: { settings: { botsEnabled: false } } }])).toBe(false);
    expect(isAnyBotsEnabled([{ serverConfig: null }])).toBe(false);

    expect(resolveSidebarModeFilter("bots", false)).toBe("all");
    expect(resolveSidebarModeFilter("bots", true)).toBe("bots");
    expect(resolveSidebarModeFilter("code", false)).toBe("code");
  });
});
