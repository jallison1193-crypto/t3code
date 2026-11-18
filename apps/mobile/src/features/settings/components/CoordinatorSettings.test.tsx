import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  defaultValue: string;
  placeholder?: string;
  editable?: boolean;
  onChangeText: (text: string) => void;
  onEndEditing: () => void;
};

type ButtonProps = {
  label: string;
  disabled?: boolean;
  onPress: () => void;
};

const state = vi.hoisted(() => ({
  inputs: new Map<string, InputProps>(),
  buttons: new Map<string, ButtonProps>(),
  threads: new Map<string, { readonly id: ThreadId; readonly title: string }>(),
  updateSettings:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { patch: ServerSettingsPatch };
      }) => Promise<{ _tag: "Success"; value: undefined }>
    >(),
  canWrite: true,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (text: string) => text,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    state.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../../components/ui/Dialog", () => ({
  alert: vi.fn(),
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({
    title,
    trailing,
    footer,
    children,
  }: {
    title?: string;
    trailing?: ReactNode;
    footer?: string;
    children: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      {trailing}
      {children}
      {footer ? <span>{footer}</span> : null}
    </div>
  ),
}));
vi.mock("../../../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef | null) =>
    ref === null ? null : (state.threads.get(`${ref.environmentId}:${ref.threadId}`) ?? null),
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: {
    updateSettings: "updateSettings",
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => state.updateSettings,
}));
vi.mock("../../../state/session", () => ({
  useEnvironmentsWithScope: (envs: ReadonlyArray<{ environmentId: EnvironmentId }>) =>
    new Set(state.canWrite ? envs.map((env) => env.environmentId) : []),
  readEnvironmentScope: () => state.canWrite,
}));

import { CoordinatorSettings } from "./CoordinatorSettings";

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const instanceId = ProviderInstanceId.make("codex");
const coordThreadId = ThreadId.make("thread-coord");

let root: Root;
let container: HTMLDivElement;

function makeTarget(overrides?: {
  coordinatorInstructions?: string;
  coordinatorThreadId?: ThreadId;
}) {
  const projectOverride = {
    ...(overrides?.coordinatorInstructions !== undefined
      ? { coordinatorInstructions: overrides.coordinatorInstructions }
      : {}),
    ...(overrides?.coordinatorThreadId !== undefined
      ? { coordinatorThreadId: overrides.coordinatorThreadId }
      : {}),
  };
  return {
    environmentId: envId,
    label: "Local",
    connection: { phase: "connected" as const },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        ...(Object.keys(projectOverride).length > 0
          ? { projectSettingsOverrides: { [projectId]: projectOverride } }
          : {}),
      },
      managedPolicy: undefined,
      environment: { platform: { machine: "server" as const }, capabilities: {} },
    },
  };
}

function makeMember() {
  return {
    id: projectId,
    environmentId: envId,
    title: "Repo",
    workspaceRoot: "/work/repo",
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  state.inputs.clear();
  state.buttons.clear();
  state.threads.clear();
  state.canWrite = true;
  state.updateSettings.mockReset();
  state.updateSettings.mockResolvedValue({ _tag: "Success", value: undefined });
});

afterEach(() => {
  act(() => root.unmount());
});

describe("mobile CoordinatorSettings", () => {
  it("saves trimmed coordinator instructions on end editing and renders None without Clear", async () => {
    act(() =>
      root.render(
        <CoordinatorSettings
          environments={[makeTarget() as never]}
          members={[makeMember() as never]}
        />,
      ),
    );

    expect(container.textContent).toContain("None");
    expect(state.buttons.get("Clear")).toBeUndefined();

    const input = state.inputs.get("Coordinator instructions")!;
    act(() => {
      input.onChangeText("  Coordinate releases cleanly.  ");
      input.onEndEditing();
    });

    await vi.waitFor(() => {
      expect(state.updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(state.updateSettings).toHaveBeenCalledWith({
      environmentId: envId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: {
              coordinatorInstructions: "Coordinate releases cleanly.",
            },
          },
        },
      },
    });
  });

  it("shows coordinator thread title and clears coordinatorThreadId while preserving instructions", async () => {
    state.threads.set(`${envId}:${coordThreadId}`, {
      id: coordThreadId,
      title: "Coordinator One",
    });

    act(() =>
      root.render(
        <CoordinatorSettings
          environments={[
            makeTarget({
              coordinatorInstructions: "Keep deploys green.",
              coordinatorThreadId: coordThreadId,
            }) as never,
          ]}
          members={[makeMember() as never]}
        />,
      ),
    );

    expect(container.textContent).toContain("Coordinator One");
    const clearButton = state.buttons.get("Clear");
    expect(clearButton).toBeDefined();

    act(() => {
      clearButton!.onPress();
    });

    await vi.waitFor(() => {
      expect(state.updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(state.updateSettings).toHaveBeenCalledWith({
      environmentId: envId,
      input: {
        patch: {
          projectSettingsOverrides: {
            [projectId]: {
              coordinatorInstructions: "Keep deploys green.",
            },
          },
        },
      },
    });
  });
});
