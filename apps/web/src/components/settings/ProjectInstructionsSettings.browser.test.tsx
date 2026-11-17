import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
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

import { ProjectInstructionsSettings } from "./ProjectInstructionsSettings";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("codex");

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
      <ProjectInstructionsSettings />
    </SettingsScopeProvider>
  );
}

function setup(initialInstructions?: string) {
  vi.clearAllMocks();
  state.canWrite = true;
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
  state.environments = [
    makeEnvironment({
      ...DEFAULT_SERVER_SETTINGS,
      ...(initialInstructions !== undefined
        ? {
            projectSettingsOverrides: {
              [projectId]: { projectInstructions: initialInstructions },
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

describe("ProjectInstructionsSettings", () => {
  it("renders null outside SettingsScopeProvider", async () => {
    setup();
    await using screen = await render(<ProjectInstructionsSettings />);
    expect(screen.container.textContent).toBe("");
  });

  it("saves trimmed project instructions on blur", async () => {
    setup();
    await using _screen = await render(<Harness />);

    await expect
      .element(page.getByText("Shared with every thread in this project, whatever the provider."))
      .toBeVisible();

    const textarea = page.getByLabelText("Project instructions");
    await userEvent.click(textarea);
    await userEvent.type(textarea, "  Always run typecheck before finishing.  ");
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
              projectInstructions: "Always run typecheck before finishing.",
            },
          },
        },
      },
    });
  });

  it("clears the project override when the instructions are emptied", async () => {
    setup("Follow strict TypeScript rules.");
    await using _screen = await render(<Harness />);

    const textarea = page.getByLabelText("Project instructions");
    await expect.element(textarea).toHaveValue("Follow strict TypeScript rules.");
    await userEvent.click(textarea);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "   ");
    (document.activeElement as HTMLElement | null)?.blur();

    await vi.waitFor(() => {
      expect(state.updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      environmentId: envId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: null,
          },
        },
      },
    });
  });

  it("clears the project override via the reset button", async () => {
    setup("Follow strict TypeScript rules.");
    await using _screen = await render(<Harness />);

    const resetButton = page.getByRole("button", {
      name: "Reset Project instructions to default",
    });
    await expect.element(resetButton).toBeVisible();
    await userEvent.click(resetButton);

    await vi.waitFor(() => {
      expect(state.updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      environmentId: envId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: null,
          },
        },
      },
    });
  });
});
