import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isEligibleWorkModeLandingProject,
  resolveChatIndexLandingTarget,
  shouldNavigateBootstrapThreadOnIndex,
  type ChatIndexLandingThread,
} from "./chatIndexLanding.logic";
import type { Project } from "./types";

const ENV_LOCAL = EnvironmentId.make("env-local");
const ENV_REMOTE = EnvironmentId.make("env-remote");

const DEFAULT_GROUPING = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

const SHARED_REPO_IDENTITY = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
  rootPath: "/workspaces/shared-repo",
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: ENV_LOCAL,
    title: "Project 1",
    workspaceRoot: "/workspaces/project-1",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeThread(
  project: Pick<Project, "environmentId" | "id">,
  overrides: Partial<ChatIndexLandingThread> = {},
): ChatIndexLandingThread {
  return {
    environmentId: project.environmentId,
    projectId: project.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("chatIndexLanding.logic", () => {
  it("preserves Code mode default draft landing on the most recent non-archived project", () => {
    const older = makeProject({
      id: ProjectId.make("proj-older"),
      title: "Older",
      workspaceRoot: "/workspaces/older",
    });
    const newer = makeProject({
      id: ProjectId.make("proj-newer"),
      title: "Newer",
      workspaceRoot: "/workspaces/newer",
    });
    const archived = makeProject({
      id: ProjectId.make("proj-archived"),
      title: "Archived",
      workspaceRoot: "/workspaces/archived",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });

    const target = resolveChatIndexLandingTarget({
      appMode: "code",
      projects: [older, newer, archived],
      threads: [
        makeThread(older, { updatedAt: "2026-01-05T00:00:00.000Z" }),
        makeThread(newer, { updatedAt: "2026-01-10T00:00:00.000Z" }),
        makeThread(archived, { updatedAt: "2026-02-01T00:00:00.000Z" }),
      ],
      projectGroupingSettings: DEFAULT_GROUPING,
      primaryEnvironmentId: ENV_LOCAL,
    });

    expect(target).toEqual({
      kind: "draft-thread",
      projectRef: { environmentId: ENV_LOCAL, projectId: ProjectId.make("proj-newer") },
    });
  });

  it("opens the most recent eligible project home in Work mode, including ordinary non-Git folders", () => {
    const gitRepo = makeProject({
      id: ProjectId.make("proj-git"),
      title: "Repo",
      workspaceRoot: "/workspaces/shared-repo",
      repositoryIdentity: SHARED_REPO_IDENTITY,
    });
    const plainFolder = makeProject({
      id: ProjectId.make("proj-notes"),
      title: "Notes",
      workspaceRoot: "/Users/josh/Documents/Notes",
      repositoryIdentity: null,
    });

    const target = resolveChatIndexLandingTarget({
      appMode: "work",
      projects: [gitRepo, plainFolder],
      threads: [
        makeThread(gitRepo, { updatedAt: "2026-01-05T00:00:00.000Z" }),
        makeThread(plainFolder, { updatedAt: "2026-01-12T00:00:00.000Z" }),
      ],
      projectGroupingSettings: DEFAULT_GROUPING,
      primaryEnvironmentId: ENV_LOCAL,
    });

    expect(target).toEqual({
      kind: "project-home",
      projectRef: { environmentId: ENV_LOCAL, projectId: ProjectId.make("proj-notes") },
      projectKey: "env-local:/Users/josh/Documents/Notes",
    });
  });

  it("excludes archived and scratch projects in Work mode and falls back to empty when none remain", () => {
    const flaggedScratch = makeProject({
      id: ProjectId.make("proj-scratch-flag"),
      title: "No project",
      workspaceRoot: "/home/josh/.t3/scratch",
      isScratch: true,
    });
    const pathScratch = makeProject({
      id: ProjectId.make("proj-scratch-path"),
      environmentId: ENV_REMOTE,
      title: "scratch",
      workspaceRoot: "/remote/.t3/scratch",
    });
    const archived = makeProject({
      id: ProjectId.make("proj-archived"),
      title: "Archived",
      workspaceRoot: "/workspaces/archived",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const realFolder = makeProject({
      id: ProjectId.make("proj-taxes"),
      title: "Taxes",
      workspaceRoot: "/Users/josh/Taxes",
    });

    const getScratchWorkspaceRoot = (environmentId: EnvironmentId) =>
      environmentId === ENV_REMOTE ? "/remote/.t3/scratch" : "/home/josh/.t3/scratch";

    expect(isEligibleWorkModeLandingProject(flaggedScratch, "/home/josh/.t3/scratch")).toBe(false);
    expect(isEligibleWorkModeLandingProject(pathScratch, "/remote/.t3/scratch")).toBe(false);
    expect(isEligibleWorkModeLandingProject(archived, "/home/josh/.t3/scratch")).toBe(false);
    expect(isEligibleWorkModeLandingProject(realFolder, "/home/josh/.t3/scratch")).toBe(true);

    expect(
      resolveChatIndexLandingTarget({
        appMode: "work",
        projects: [flaggedScratch, pathScratch, archived, realFolder],
        threads: [
          makeThread(flaggedScratch, { updatedAt: "2026-03-01T00:00:00.000Z" }),
          makeThread(pathScratch, { updatedAt: "2026-03-02T00:00:00.000Z" }),
          makeThread(realFolder, { updatedAt: "2026-01-03T00:00:00.000Z" }),
        ],
        projectGroupingSettings: DEFAULT_GROUPING,
        primaryEnvironmentId: ENV_LOCAL,
        getScratchWorkspaceRoot,
      }),
    ).toEqual({
      kind: "project-home",
      projectRef: { environmentId: ENV_LOCAL, projectId: ProjectId.make("proj-taxes") },
      projectKey: "env-local:/Users/josh/Taxes",
    });

    expect(
      resolveChatIndexLandingTarget({
        appMode: "work",
        projects: [flaggedScratch, pathScratch, archived],
        threads: [makeThread(flaggedScratch, { updatedAt: "2026-03-01T00:00:00.000Z" })],
        projectGroupingSettings: DEFAULT_GROUPING,
        primaryEnvironmentId: ENV_LOCAL,
        getScratchWorkspaceRoot,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("resolves multi-environment logical project keys across repository, separate, and partially archived groups", () => {
    const localRepo = makeProject({
      id: ProjectId.make("proj-local"),
      environmentId: ENV_LOCAL,
      title: "shared-repo",
      workspaceRoot: "/workspaces/shared-repo",
      repositoryIdentity: SHARED_REPO_IDENTITY,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const remoteRepo = makeProject({
      id: ProjectId.make("proj-remote"),
      environmentId: ENV_REMOTE,
      title: "shared-repo",
      workspaceRoot: "/srv/shared-repo",
      repositoryIdentity: {
        ...SHARED_REPO_IDENTITY,
        rootPath: "/srv/shared-repo",
      },
    });

    expect(
      resolveChatIndexLandingTarget({
        appMode: "work",
        projects: [localRepo, remoteRepo],
        threads: [makeThread(remoteRepo, { updatedAt: "2026-02-10T00:00:00.000Z" })],
        projectGroupingSettings: DEFAULT_GROUPING,
        primaryEnvironmentId: ENV_LOCAL,
      }),
    ).toEqual({
      kind: "project-home",
      projectRef: { environmentId: ENV_REMOTE, projectId: ProjectId.make("proj-remote") },
      projectKey: "github.com/example/shared-repo",
    });

    expect(
      resolveChatIndexLandingTarget({
        appMode: "work",
        projects: [{ ...localRepo, archivedAt: null }, remoteRepo],
        threads: [
          makeThread(localRepo, { updatedAt: "2026-02-01T00:00:00.000Z" }),
          makeThread(remoteRepo, { updatedAt: "2026-02-10T00:00:00.000Z" }),
        ],
        projectGroupingSettings: {
          sidebarProjectGroupingMode: "separate",
          sidebarProjectGroupingOverrides: {},
        },
        primaryEnvironmentId: ENV_LOCAL,
      }),
    ).toEqual({
      kind: "project-home",
      projectRef: { environmentId: ENV_REMOTE, projectId: ProjectId.make("proj-remote") },
      projectKey: "env-remote:/srv/shared-repo",
    });
  });

  it("suppresses welcome bootstrap thread hijack on the index route only in Work mode", () => {
    expect(shouldNavigateBootstrapThreadOnIndex("code")).toBe(true);
    expect(shouldNavigateBootstrapThreadOnIndex("work")).toBe(false);
  });
});
