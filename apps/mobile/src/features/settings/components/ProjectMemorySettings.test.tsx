import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  PROJECT_MEMORY_MAX_BYTES,
  ProjectId,
  ProjectMemoryRpcError,
  type ProjectMemoryGetResult,
  type ProjectMemorySetResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  value?: string;
  editable?: boolean;
  onChangeText: (text: string) => void;
};

type ButtonProps = {
  label: string;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
};

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("proj-1");

const state = vi.hoisted(() => ({
  inputs: new Map<string, InputProps>(),
  buttons: new Map<string, ButtonProps>(),
  canEdit: true,
  memoryResult: null as unknown as AsyncResult.AsyncResult<ProjectMemoryGetResult, unknown>,
  memoryGetCalls: 0,
  setMemory:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: { projectId: ProjectId; content: string };
      }) => Promise<
        | { readonly _tag: "Success"; readonly value: ProjectMemorySetResult }
        | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
      >
    >(),
}));

const memoryAtom = Atom.make(() => {
  state.memoryGetCalls += 1;
  return state.memoryResult;
});
const canEditAtom = Atom.make(() => state.canEdit);

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (text: string, vars?: Record<string, unknown>) =>
    vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : text,
}));
vi.mock("../../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span>loading</span>,
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
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({
    title,
    footer,
    children,
  }: {
    title?: string;
    footer?: string;
    children: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      {children}
      {footer ? <span>{footer}</span> : null}
    </div>
  ),
}));
vi.mock("../../../state/projects", () => ({
  projectEnvironment: {
    memoryGet: () => memoryAtom,
    memorySet: {
      permissionAtom: () => canEditAtom,
    },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => state.setMemory,
}));

import { ProjectMemorySettings } from "./ProjectMemorySettings";

let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;

function render(connected = true) {
  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings environmentId={envId} projectId={projectId} connected={connected} />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  registry = AtomRegistry.make();
  state.inputs.clear();
  state.buttons.clear();
  state.canEdit = true;
  state.memoryGetCalls = 0;
  state.memoryResult = AsyncResult.success({
    projectId,
    exists: true,
    content: "# Initial memory",
    sizeBytes: 16,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  state.setMemory.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("mobile ProjectMemorySettings", () => {
  it("shows reconnect message when disconnected without querying memoryGet", () => {
    render(false);
    expect(container.textContent).toContain(
      "Connect this machine to view and edit project memory.",
    );
    expect(state.memoryGetCalls).toBe(0);
  });

  it("edits and saves memory explicitly and supports discard", async () => {
    state.setMemory.mockImplementation(async ({ input }) => {
      state.memoryResult = AsyncResult.success({
        projectId,
        exists: true,
        content: input.content,
        sizeBytes: new TextEncoder().encode(input.content).byteLength,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      registry.refresh(memoryAtom);
      return {
        _tag: "Success",
        value: {
          projectId,
          sizeBytes: new TextEncoder().encode(input.content).byteLength,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      };
    });

    render(true);
    expect(state.inputs.get("Project memory")?.value).toBe("# Initial memory");
    expect(state.buttons.get("Save memory")?.disabled).toBe(true);

    act(() => state.inputs.get("Project memory")!.onChangeText("Edited"));
    expect(state.buttons.get("Save memory")?.disabled).toBe(false);
    expect(state.buttons.get("Discard")).toBeDefined();

    act(() => state.buttons.get("Discard")!.onPress());
    expect(state.inputs.get("Project memory")?.value).toBe("# Initial memory");

    act(() => state.inputs.get("Project memory")!.onChangeText("Saved note"));
    await act(async () => {
      state.buttons.get("Save memory")!.onPress();
    });

    expect(state.setMemory).toHaveBeenCalledWith({
      environmentId: envId,
      input: { projectId, content: "Saved note" },
    });
    expect(state.inputs.get("Project memory")?.value).toBe("Saved note");
  });

  it("blocks over-limit memory and surfaces RPC errors", async () => {
    render(true);
    act(() =>
      state.inputs.get("Project memory")!.onChangeText("x".repeat(PROJECT_MEMORY_MAX_BYTES + 1)),
    );
    expect(container.textContent).toContain("UTF-8 byte limit");
    expect(state.buttons.get("Save memory")?.disabled).toBe(true);

    state.setMemory.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new ProjectMemoryRpcError({
          projectId,
          failure: "operation_failed",
          message: "Memory write failed",
        }),
      ),
    });
    act(() => state.inputs.get("Project memory")!.onChangeText("Valid text"));
    await act(async () => {
      state.buttons.get("Save memory")!.onPress();
    });
    expect(container.textContent).toContain("Memory write failed");
  });
});
