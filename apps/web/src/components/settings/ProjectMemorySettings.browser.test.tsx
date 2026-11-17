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
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("proj-1");

const state = vi.hoisted(() => ({
  scopeContext: null as {
    readonly scope: {
      readonly kind: "all" | "environment" | "project" | "checkout";
      readonly members: ReadonlyArray<unknown>;
    };
    readonly targets: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId | null;
    }>;
  } | null,
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

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: () =>
    (state.scopeContext && {
      connectedEnvironments: [],
      ...state.scopeContext,
      scope: { environmentIds: [], ...state.scopeContext.scope },
    }) as never,
}));

vi.mock(import("../../state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      memoryGet: () => memoryAtom,
      memorySet: {
        ...actual.projectEnvironment.memorySet,
        permissionAtom: () => canEditAtom,
      },
    } as unknown as typeof actual.projectEnvironment,
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.setMemory) as never,
}));

import { ProjectMemorySettings } from "./ProjectMemorySettings";

function singleProjectScope(connected = true) {
  return {
    scope: {
      kind: "project" as const,
      members: [{}],
    },
    targets: connected ? [{ environmentId: envId, projectId }] : [],
  };
}

function setup(connected = true) {
  state.scopeContext = singleProjectScope(connected);
  state.canEdit = true;
  state.memoryGetCalls = 0;
  state.memoryResult = AsyncResult.success({
    projectId,
    exists: true,
    content: "# Memory\nExisting notes",
    sizeBytes: 23,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  state.setMemory.mockReset();
  return AtomRegistry.make();
}

describe("ProjectMemorySettings", () => {
  it("renders null when scope is not a single selected project", async () => {
    const registry = setup();
    state.scopeContext = null;
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );
    expect(screen.container.textContent).toBe("");

    state.scopeContext = {
      scope: { kind: "project", members: [{}, {}] },
      targets: [
        { environmentId: envId, projectId },
        { environmentId: envId, projectId: ProjectId.make("proj-2") },
      ],
    };
    await screen.rerender(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("shows reconnect message when the single project target is offline", async () => {
    const registry = setup(false);
    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );
    await expect
      .element(
        page.getByText("Reconnect the selected environment to view and edit project memory."),
      )
      .toBeVisible();
    expect(state.memoryGetCalls).toBe(0);
  });

  it("renders MEMORY.md content, updates UTF-8 byte counter, and saves explicitly", async () => {
    const registry = setup();
    state.setMemory.mockImplementation(async ({ input }) => {
      const next: ProjectMemoryGetResult = {
        projectId,
        exists: true,
        content: input.content,
        sizeBytes: new TextEncoder().encode(input.content).byteLength,
        updatedAt: "2026-01-02T00:00:00.000Z",
      };
      state.memoryResult = AsyncResult.success(next);
      registry.refresh(memoryAtom);
      return {
        _tag: "Success",
        value: {
          projectId,
          sizeBytes: next.sizeBytes,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      };
    });

    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );

    const textarea = page.getByLabelText("Project memory");
    await expect.element(textarea).toHaveValue("# Memory\nExisting notes");
    const saveButton = page.getByRole("button", { name: "Save memory" });
    await expect.element(saveButton).toBeDisabled();

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Updated notes €");

    await expect
      .element(page.getByText(`17 / ${PROJECT_MEMORY_MAX_BYTES.toLocaleString()} bytes`))
      .toBeVisible();
    expect(state.setMemory).not.toHaveBeenCalled();

    await userEvent.click(saveButton);
    await vi.waitFor(() => {
      expect(state.setMemory).toHaveBeenCalledTimes(1);
    });
    expect(state.setMemory).toHaveBeenLastCalledWith({
      environmentId: envId,
      input: {
        projectId,
        content: "Updated notes €",
      },
    });
    await expect.element(textarea).toHaveValue("Updated notes €");
    expect(state.memoryGetCalls).toBeGreaterThanOrEqual(2);
  });

  it("blocks saving when exceeding PROJECT_MEMORY_MAX_BYTES and displays RPC save errors", async () => {
    const registry = setup();
    state.memoryResult = AsyncResult.success({
      projectId,
      exists: false,
      content: "a".repeat(PROJECT_MEMORY_MAX_BYTES),
      sizeBytes: PROJECT_MEMORY_MAX_BYTES,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );

    const textarea = page.getByLabelText("Project memory");
    await userEvent.click(textarea);
    await userEvent.type(textarea, "b");

    await expect.element(page.getByText(/exceeds the .* UTF-8 byte limit/i)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save memory" })).toBeDisabled();

    // Now return within limit and fail RPC on save
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Valid content");
    state.setMemory.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new ProjectMemoryRpcError({
          projectId,
          failure: "memory_too_large",
          message: "Too large on server",
        }),
      ),
    });

    await userEvent.click(page.getByRole("button", { name: "Save memory" }));
    await expect.element(page.getByText("Too large on server")).toBeVisible();
  });

  it("shows loading, load failure with retry, and read-only permission state", async () => {
    const registry = setup();
    state.memoryResult = AsyncResult.initial();

    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );
    await expect.element(page.getByText("Loading MEMORY.md...")).toBeVisible();

    state.memoryResult = AsyncResult.failure(
      Cause.fail(
        new ProjectMemoryRpcError({
          projectId,
          failure: "operation_failed",
          message: "Disk read failed",
        }),
      ),
    );
    registry.refresh(memoryAtom);
    await screen.rerender(
      <RegistryContext.Provider value={registry}>
        <ProjectMemorySettings />
      </RegistryContext.Provider>,
    );
    await expect.element(page.getByText("Disk read failed")).toBeVisible();
    const callsBeforeRetry = state.memoryGetCalls;
    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    expect(state.memoryGetCalls).toBeGreaterThan(callsBeforeRetry);
  });
});
