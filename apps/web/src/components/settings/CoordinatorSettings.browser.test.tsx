import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  threads: new Map<string, { readonly id: ThreadId; readonly title: string }>(),
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" };
    serverConfig: {
      keybindings: typeof DEFAULT_RESOLVED_KEYBINDINGS;
      settings: typeof DEFAULT_SERVER_SETTINGS;
      environment: { platform: { machine: "server" }; capabilities: Record<string, never> };
    };
  }>,
  updateSettings:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { patch: ServerSettingsPatch };
      }) => Promise<unknown>
    >(),
  canWrite: true,
}));

const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  readEnvironment: ((id: EnvironmentId) =>
    state.environments.find((environment) => environment.environmentId === id) ?? null) as never,
  usePrimaryEnvironmentId: () => state.environments[0]?.environmentId ?? null,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShell: ((ref: ScopedThreadRef | null) =>
    ref === null
      ? null
      : (state.threads.get(`${ref.environmentId}:${ref.threadId}`) ?? null)) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canWrite,
  useEnvironmentsWithScope: ((envs: ReadonlyArray<{ environmentId: EnvironmentId }>) =>
    new Set(state.canWrite ? envs.map((env) => env.environmentId) : [])) as never,
  readEnvironmentScope: () => state.canWrite,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "updateSettings" ? state.updateSettings : vi.fn()) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));

import { CoordinatorSettings } from "./CoordinatorSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("codex");
const coordThreadId = ThreadId.make("thread-coord");

function makeEnvironment(settings = DEFAULT_SERVER_SETTINGS) {
  return {
    environmentId: envId,
    label: "Local",
    connection: { phase: "connected" as const },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings,
      environment: { platform: { machine: "server" as const }, capabilities: {} },
    },
  };
}

function Harness() {
  const groups = useSettingsProjectGroups();
  const group = groups[0]!;
  return (
    <SettingsScopeProvider
      search={{ project: group.projectKey, machine: undefined, checkout: undefined }}
      onChange={() => {}}
    >
      <CoordinatorSettings />
    </SettingsScopeProvider>
  );
}

function setup(overrides?: {
  coordinatorInstructions?: string;
  coordinatorThreadId?: ThreadId;
  threadTitle?: string | null;
}) {
  vi.clearAllMocks();
  state.canWrite = true;
  state.threads = new Map();
  if (overrides?.coordinatorThreadId && overrides.threadTitle !== null) {
    state.threads.set(`${envId}:${overrides.coordinatorThreadId}`, {
      id: overrides.coordinatorThreadId,
      title: overrides.threadTitle ?? "Release Coordinator",
    });
  }
  state.projects = [
    {
      id: projectId,
      environmentId: envId,
      title: "Repo",
      workspaceRoot: "/work/repo",
      defaultModelSelection: { instanceId, model: "gpt-5-codex" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    },
  ];
  const projectOverride = {
    ...(overrides?.coordinatorInstructions !== undefined
      ? { coordinatorInstructions: overrides.coordinatorInstructions }
      : {}),
    ...(overrides?.coordinatorThreadId !== undefined
      ? { coordinatorThreadId: overrides.coordinatorThreadId }
      : {}),
  };
  state.environments = [
    makeEnvironment({
      ...DEFAULT_SERVER_SETTINGS,
      ...(Object.keys(projectOverride).length > 0
        ? {
            projectSettingsOverrides: {
              [projectId]: projectOverride,
            },
          }
        : {}),
    }),
  ];
  state.updateSettings.mockImplementation(async ({ environmentId, input: { patch } }) => {
    const env = state.environments.find((candidate) => candidate.environmentId === environmentId);
    if (env && patch.projectSettingsOverrides) {
      const nextOverrides = { ...env.serverConfig.settings.projectSettingsOverrides };
      for (const [key, value] of Object.entries(patch.projectSettingsOverrides)) {
        const typedKey = key as ProjectId;
        if (value === null) {
          delete nextOverrides[typedKey];
        } else {
          nextOverrides[typedKey] = value;
        }
      }
      env.serverConfig = {
        ...env.serverConfig,
        settings: {
          ...env.serverConfig.settings,
          projectSettingsOverrides: nextOverrides,
        },
      };
      state.environments = state.environments.map((candidate) =>
        candidate === env ? { ...env } : candidate,
      );
    }
    return { _tag: "Success" as const, value: undefined };
  });
}

describe("CoordinatorSettings", () => {
  it("renders null outside SettingsScopeProvider", async () => {
    setup();
    await using screen = await render(<CoordinatorSettings />);
    expect(screen.container.textContent).toBe("");
  });

  it("saves trimmed coordinator instructions on blur and shows None when no coordinator thread is set", async () => {
    setup();
    await using _screen = await render(<Harness />);

    await expect
      .element(page.getByText("Delivered only to this project's designated coordinator thread."))
      .toBeVisible();
    await expect.element(page.getByText("None")).toBeVisible();
    expect(page.getByRole("button", { name: "Clear" }).query()).toBeNull();

    const textarea = page.getByLabelText("Coordinator instructions");
    await userEvent.fill(textarea, "  Delegate worker threads before merging.  ");
    (document.activeElement as HTMLElement | null)?.blur();

    await vi.waitFor(() => {
      expect(state.updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      environmentId: envId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: {
              coordinatorInstructions: "Delegate worker threads before merging.",
            },
          },
        },
      },
    });
  });

  it("shows the coordinator thread title and clears coordinatorThreadId while keeping instructions", async () => {
    setup({
      coordinatorInstructions: "Coordinate releases.",
      coordinatorThreadId: coordThreadId,
      threadTitle: "Release Coordinator",
    });
    await using _screen = await render(<Harness />);

    await expect.element(page.getByText("Release Coordinator")).toBeVisible();
    const clearButton = page.getByRole("button", { name: "Clear" });
    await userEvent.click(clearButton);

    await vi.waitFor(() => {
      expect(state.updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      environmentId: envId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: {
              coordinatorInstructions: "Coordinate releases.",
            },
          },
        },
      },
    });
  });

  it("shows Thread not found when coordinatorThreadId cannot be resolved", async () => {
    setup({
      coordinatorThreadId: coordThreadId,
      threadTitle: null,
    });
    await using _screen = await render(<Harness />);

    await expect.element(page.getByText("Thread not found")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Clear" })).toBeVisible();
  });
});
