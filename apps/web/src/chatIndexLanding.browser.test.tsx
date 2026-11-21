import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { useSyncExternalStore } from "react";
import { act, render } from "../test/render";
import type { ChatIndexLandingThread } from "./chatIndexLanding.logic";
import { DraftId } from "./composerDraftStore";
import type { Project } from "./types";

const ENV_LOCAL = EnvironmentId.make("env-local");
const ENV_REMOTE = EnvironmentId.make("env-remote");
const shellEvents = new EventTarget();
function subscribeToShell(listener: () => void) {
  shellEvents.addEventListener("change", listener);
  return () => shellEvents.removeEventListener("change", listener);
}

const testState = {
  authGateStatus: "authenticated" as "authenticated" | "hosted-static",
  environments: [{ environmentId: ENV_LOCAL, label: "Local" }] as ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>,
  environmentsReady: true,
  primaryEnvironmentId: ENV_LOCAL as EnvironmentId | null,
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<ChatIndexLandingThread>,
  serverConfigs: new Map<EnvironmentId, { readonly scratchWorkspaceRoot?: string | null }>(),
  bootstrapped: true,
  persistedSettings: DEFAULT_CLIENT_SETTINGS as ClientSettings,
  hydrationDeferred: null as {
    readonly promise: Promise<ClientSettings>;
    readonly resolve: (settings: ClientSettings) => void;
  } | null,
  handleNewThread:
    vi.fn<
      (
        projectRef: ScopedProjectRef,
        options?: { readonly replace?: boolean },
      ) => Promise<{ draftId: DraftId; threadId: ThreadId } | null>
    >(),
};

vi.mock(import("./localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () =>
    ({
      persistence: {
        getClientSettings: async () =>
          testState.hydrationDeferred
            ? testState.hydrationDeferred.promise
            : testState.persistedSettings,
        setClientSettings: async (next: ClientSettings) => {
          testState.persistedSettings = next;
        },
      },
    }) as never,
}));

vi.mock(import("./state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(compileResolvedKeybindingsConfig([])),
  };
});

vi.mock(import("./state/entities"), async (original) => ({
  ...(await original()),
  readProject: (ref: ScopedProjectRef) =>
    testState.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null,
  useAllEnvironmentShellsBootstrapped: () =>
    useSyncExternalStore(subscribeToShell, () => testState.bootstrapped),
  useProjects: () => testState.projects,
  useServerConfigs: () => testState.serverConfigs as never,
  useVisibleThreadShells: () => testState.threads as never,
}));

vi.mock(import("./state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: () => ({
    environments: testState.environments as never,
    isReady: testState.environmentsReady,
    networkStatus: "online" as const,
    presentationById: new Map(),
  }),
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => testState.primaryEnvironmentId,
}));

vi.mock(import("./hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: () => testState.handleNewThread,
}));

vi.mock(import("./components/NoProjectsHero"), () => ({
  NoProjectsHero: () => <main data-testid="no-projects-hero">No projects hero</main>,
}));

vi.mock(import("./components/HostedEmptyState"), () => ({
  HostedEmptyState: () => <main data-testid="hosted-empty-state">Hosted empty state</main>,
}));

vi.mock(import("./components/Sidebar"), () => ({
  default: () => <div data-testid="threads-sidebar">Threads sidebar</div>,
}));

vi.mock(import("./components/sidebar/ProjectsSidebar"), () => ({
  ProjectsSidebar: () => {
    const navigate = useNavigate();
    return (
      <div data-testid="projects-sidebar">
        <span>Projects sidebar</span>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: ENV_LOCAL, threadId: "manual-thread-1" },
            })
          }
        >
          Open manual thread
        </button>
      </div>
    );
  },
}));

import { AppSidebarLayout } from "./components/AppSidebarLayout";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsPatch,
} from "./hooks/useSettings";
import { ChatIndexLandingView } from "./routes/_chat.index";

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
  updatedAt: string,
): ChatIndexLandingThread {
  return {
    environmentId: project.environmentId,
    projectId: project.id,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
  };
}

function setup(overrides: Partial<typeof testState> = {}) {
  __resetClientSettingsPersistenceForTests();
  testState.authGateStatus = "authenticated";
  testState.environments = [{ environmentId: ENV_LOCAL, label: "Local" }];
  testState.environmentsReady = true;
  testState.primaryEnvironmentId = ENV_LOCAL;
  testState.projects = [];
  testState.threads = [];
  testState.serverConfigs = new Map();
  testState.bootstrapped = true;
  testState.persistedSettings = DEFAULT_CLIENT_SETTINGS;
  testState.hydrationDeferred = null;
  testState.handleNewThread = vi.fn(async () => ({
    draftId: DraftId.make("draft-1"),
    threadId: ThreadId.make("thread-draft-1"),
  }));
  Object.assign(testState, overrides);
}

function createLandingTestRouter(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ChatIndexLandingView authGateState={{ status: testState.authGateStatus }} />,
  });
  const projectHomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectKey",
    component: () => {
      const { projectKey } = projectHomeRoute.useParams();
      return <main data-testid="project-home-route">{projectKey}</main>;
    },
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => {
      const { environmentId, threadId } = threadRoute.useParams();
      return (
        <main data-testid="thread-route">
          {environmentId}/{threadId}
        </main>
      );
    },
  });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => {
      const { draftId } = draftRoute.useParams();
      return <main data-testid="draft-route">{draftId}</main>;
    },
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/general",
    component: () => <main data-testid="settings-route">General settings</main>,
  });
  const newLinkRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/new",
    component: () => <main data-testid="new-link-route">New thread link</main>,
  });

  return createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectHomeRoute,
      threadRoute,
      draftRoute,
      settingsRoute,
      newLinkRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    disableGlobalCatchBoundary: true,
  });
}

describe("chat index Work mode landing and routing", () => {
  it("waits for settings hydration, then opens Projects sidebar and project home for a non-Git folder while keeping sidebarModeFilter", async () => {
    await page.viewport(1280, 800);
    let resolveHydration!: (settings: ClientSettings) => void;
    const hydrationPromise = new Promise<ClientSettings>((resolve) => {
      resolveHydration = resolve;
    });
    const plainFolder = makeProject({
      id: ProjectId.make("proj-folder"),
      title: "Client Notes",
      workspaceRoot: "/Users/josh/Client Notes",
      repositoryIdentity: null,
    });
    const scratchProject = makeProject({
      id: ProjectId.make("proj-scratch"),
      title: "No project",
      workspaceRoot: "/Users/josh/.t3/scratch",
      isScratch: true,
    });
    setup({
      projects: [plainFolder, scratchProject],
      bootstrapped: false,
      threads: [
        makeThread(scratchProject, "2026-03-01T00:00:00.000Z"),
        makeThread(plainFolder, "2026-02-01T00:00:00.000Z"),
      ],
      hydrationDeferred: { promise: hydrationPromise, resolve: resolveHydration },
    });

    const router = createLandingTestRouter("/");
    // Custom TanStack Router covers index and direct routes.
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    // Before settings hydrate, Work mode must not flash a Code draft or mutate sidebarLayout.
    expect(testState.handleNewThread).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/");
    expect(getClientSettings().sidebarLayout).toBe("threads");

    resolveHydration({
      ...DEFAULT_CLIENT_SETTINGS,
      appMode: "work",
      sidebarLayout: "threads",
      sidebarModeFilter: "code",
    });

    await expect.element(screen.getByTestId("projects-sidebar")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    const remoteFolder = makeProject({
      environmentId: ENV_REMOTE,
      id: ProjectId.make("remote-client-notes"),
      workspaceRoot: "/srv/Client Notes",
    });
    testState.projects = [...testState.projects, remoteFolder];
    testState.threads = [
      ...testState.threads,
      makeThread(remoteFolder, "2026-04-01T00:00:00.000Z"),
    ];
    testState.bootstrapped = true;
    await act(async () => {
      shellEvents.dispatchEvent(new Event("change"));
    });
    await expect
      .element(screen.getByTestId("project-home-route"))
      .toHaveTextContent("env-remote:/srv/Client Notes");
    await expect.element(screen.getByTestId("projects-sidebar")).toBeVisible();
    expect(testState.handleNewThread).not.toHaveBeenCalled();
    expect(getClientSettings().sidebarLayout).toBe("projects");
    expect(getClientSettings().sidebarModeFilter).toBe("code");

    // Manual sidebar navigation stays intact after Work mode landing.
    await userEvent.click(screen.getByRole("button", { name: "Open manual thread" }));
    await expect
      .element(screen.getByTestId("thread-route"))
      .toHaveTextContent("env-local/manual-thread-1");
  });

  it("resolves multi-environment repository project home on Work landing and preserves Code draft landing", async () => {
    await page.viewport(1280, 800);
    const localRepo = makeProject({
      id: ProjectId.make("proj-local"),
      environmentId: ENV_LOCAL,
      title: "shared-repo",
      workspaceRoot: "/local/shared-repo",
      repositoryIdentity: {
        canonicalKey: "github.com/acme/shared-repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/shared-repo.git",
        },
        rootPath: "/local/shared-repo",
      },
    });
    const remoteRepo = makeProject({
      id: ProjectId.make("proj-remote"),
      environmentId: ENV_REMOTE,
      title: "shared-repo",
      workspaceRoot: "/remote/shared-repo",
      repositoryIdentity: {
        canonicalKey: "github.com/acme/shared-repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/shared-repo.git",
        },
        rootPath: "/remote/shared-repo",
      },
    });

    setup({
      environments: [
        { environmentId: ENV_LOCAL, label: "Local" },
        { environmentId: ENV_REMOTE, label: "Remote" },
      ],
      projects: [localRepo, remoteRepo],
      threads: [makeThread(remoteRepo, "2026-03-10T00:00:00.000Z")],
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      appMode: "work",
      sidebarLayout: "threads",
    });

    {
      const workRouter = createLandingTestRouter("/");
      // Custom TanStack Router covers index and direct routes.
      await using screen = await render(<RouterProvider router={workRouter} />, { router: false });
      await expect
        .element(screen.getByTestId("project-home-route"))
        .toHaveTextContent("github.com/acme/shared-repo");
      await expect.element(screen.getByTestId("projects-sidebar")).toBeVisible();
    }

    // Code mode keeps its default draft landing and does not switch sidebarLayout.
    setup({
      projects: [localRepo, remoteRepo],
      threads: [makeThread(remoteRepo, "2026-03-10T00:00:00.000Z")],
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      appMode: "code",
      sidebarLayout: "threads",
      sidebarModeFilter: "work",
    });
    const codeRouter = createLandingTestRouter("/");
    // Custom TanStack Router covers index and direct routes.
    await using codeScreen = await render(<RouterProvider router={codeRouter} />, {
      router: false,
    });
    await vi.waitFor(() =>
      expect(testState.handleNewThread).toHaveBeenCalledWith(
        { environmentId: ENV_REMOTE, projectId: ProjectId.make("proj-remote") },
        { replace: true },
      ),
    );
    await expect.element(codeScreen.getByTestId("threads-sidebar")).toBeVisible();
    expect(getClientSettings().sidebarLayout).toBe("threads");
    expect(getClientSettings().sidebarModeFilter).toBe("work");
  });

  it("shows Projects sidebar and NoProjectsHero when Work mode has no eligible project, and allows manual sidebar switch", async () => {
    await page.viewport(1280, 800);
    const archived = makeProject({
      id: ProjectId.make("proj-archived"),
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    setup({
      projects: [archived],
      bootstrapped: true,
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      appMode: "work",
      sidebarLayout: "threads",
    });

    const router = createLandingTestRouter("/");
    // Custom TanStack Router covers index and direct routes.
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await expect.element(screen.getByTestId("no-projects-hero")).toBeVisible();
    await expect.element(screen.getByTestId("projects-sidebar")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");

    // Manual sidebar toggle must not be fought by the landing effect.
    await persistClientSettingsPatch({ sidebarLayout: "threads" });
    await expect.element(screen.getByTestId("threads-sidebar")).toBeVisible();
  });

  it("keeps hosted unpaired on HostedEmptyState without mutating sidebarLayout, and lands when hosted is paired", async () => {
    await page.viewport(1280, 800);
    setup({
      authGateStatus: "hosted-static",
      environments: [],
      environmentsReady: true,
      primaryEnvironmentId: null,
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      appMode: "work",
      sidebarLayout: "threads",
    });

    {
      const unpairedRouter = createLandingTestRouter("/");
      // Custom TanStack Router covers index and direct routes.
      await using screen = await render(<RouterProvider router={unpairedRouter} />, {
        router: false,
      });
      await expect.element(screen.getByTestId("hosted-empty-state")).toBeVisible();
      expect(unpairedRouter.state.location.pathname).toBe("/");
      expect(getClientSettings().sidebarLayout).toBe("threads");
    }

    const remoteFolder = makeProject({
      id: ProjectId.make("proj-remote-folder"),
      environmentId: ENV_REMOTE,
      title: "Remote Docs",
      workspaceRoot: "/srv/docs",
    });
    setup({
      authGateStatus: "hosted-static",
      environments: [{ environmentId: ENV_REMOTE, label: "Remote" }],
      environmentsReady: true,
      primaryEnvironmentId: null,
      projects: [remoteFolder],
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      appMode: "work",
      sidebarLayout: "threads",
    });

    const pairedRouter = createLandingTestRouter("/");
    // Custom TanStack Router covers index and direct routes.
    await using pairedScreen = await render(<RouterProvider router={pairedRouter} />, {
      router: false,
    });
    await expect
      .element(pairedScreen.getByTestId("project-home-route"))
      .toHaveTextContent("env-remote:/srv/docs");
    await expect.element(pairedScreen.getByTestId("projects-sidebar")).toBeVisible();
  });

  it("preserves explicit direct routes on load/reload and preserves open thread and draft when switching appMode", async () => {
    await page.viewport(1280, 800);
    const project = makeProject({
      id: ProjectId.make("proj-main"),
      title: "Main",
      workspaceRoot: "/workspaces/main",
    });

    for (const [entry, testId, expectedText] of [
      ["/env-local/thread-42", "thread-route", "env-local/thread-42"],
      ["/projects/custom-key", "project-home-route", "custom-key"],
      ["/settings/general", "settings-route", "General settings"],
      ["/new?prompt=hello", "new-link-route", "New thread link"],
      ["/draft/draft-9", "draft-route", "draft-9"],
    ] as const) {
      setup({ projects: [project] });
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        appMode: "work",
        sidebarLayout: "threads",
      });
      const directRouter = createLandingTestRouter(entry);
      // Custom TanStack Router covers index and direct routes.
      await using screen = await render(<RouterProvider router={directRouter} />, {
        router: false,
      });
      await expect.element(screen.getByTestId(testId)).toHaveTextContent(expectedText);
      expect(getClientSettings().sidebarLayout).toBe("threads");
      expect(testState.handleNewThread).not.toHaveBeenCalled();

      if (entry === "/env-local/thread-42" || entry === "/draft/draft-9") {
        await persistClientSettingsPatch({ appMode: "code" });
        await persistClientSettingsPatch({ appMode: "work" });
        await expect.element(screen.getByTestId(testId)).toHaveTextContent(expectedText);
      }
    }
  });
});
