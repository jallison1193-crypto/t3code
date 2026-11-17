import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  ProjectId,
  type ProjectKnowledgeAddResult,
  type ProjectKnowledgeDeleteResult,
  type ProjectKnowledgeGetResult,
  type ProjectKnowledgeListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
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
  canAdd: true,
  canDelete: true,
  listResult: null as unknown as AsyncResult.AsyncResult<ProjectKnowledgeListResult, unknown>,
  detailResult: null as unknown as AsyncResult.AsyncResult<ProjectKnowledgeGetResult, unknown>,
  addKnowledge:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: { projectId: ProjectId; name: string; content: string };
      }) => Promise<
        | { readonly _tag: "Success"; readonly value: ProjectKnowledgeAddResult }
        | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
      >
    >(),
  deleteKnowledge:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: { projectId: ProjectId; name: string };
      }) => Promise<
        | { readonly _tag: "Success"; readonly value: ProjectKnowledgeDeleteResult }
        | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
      >
    >(),
  extractPdf: vi.fn<(file: File) => Promise<string>>(),
}));

const listAtom = Atom.make(() => state.listResult);
const detailAtom = Atom.make(() => state.detailResult);
const canAddAtom = Atom.make(() => state.canAdd);
const canDeleteAtom = Atom.make(() => state.canDelete);

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: () =>
    (state.scopeContext && {
      connectedEnvironments: [],
      ...state.scopeContext,
      scope: { environmentIds: [], ...state.scopeContext.scope },
    }) as never,
}));

vi.mock(import("./projectKnowledgePdf"), () => ({
  extractPdfTextAsMarkdown: (file: File) => state.extractPdf(file),
}));

vi.mock(import("../../state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      knowledgeList: () => listAtom,
      knowledgeGet: () => detailAtom,
      knowledgeAdd: {
        ...actual.projectEnvironment.knowledgeAdd,
        __cmd: "add",
        permissionAtom: () => canAddAtom,
      },
      knowledgeDelete: {
        ...actual.projectEnvironment.knowledgeDelete,
        __cmd: "delete",
        permissionAtom: () => canDeleteAtom,
      },
    } as unknown as typeof actual.projectEnvironment,
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly __cmd?: string }) =>
    command?.__cmd === "add" ? state.addKnowledge : state.deleteKnowledge) as never,
}));

import { ProjectKnowledgeSettings } from "./ProjectKnowledgeSettings";

function singleProjectScope() {
  return {
    scope: { kind: "project" as const, members: [{}] },
    targets: [{ environmentId: envId, projectId }],
  };
}

function setup() {
  state.scopeContext = singleProjectScope();
  state.canAdd = true;
  state.canDelete = true;
  state.listResult = AsyncResult.success({
    projectId,
    files: [
      {
        name: "architecture.md",
        sizeBytes: 2048,
        updatedAt: "2026-01-01T12:00:00.000Z",
      },
    ],
  });
  state.detailResult = AsyncResult.success({
    projectId,
    name: "architecture.md",
    content: "# Architecture\nRead-only knowledge body",
    startLine: 1,
    endLine: 2,
    totalLines: 2,
    sizeBytes: 38,
    updatedAt: "2026-01-01T12:00:00.000Z",
  });
  state.addKnowledge.mockReset();
  state.deleteKnowledge.mockReset();
  state.extractPdf.mockReset();
  return AtomRegistry.make();
}

describe("ProjectKnowledgeSettings", () => {
  it("renders null when scope is not a single project", async () => {
    const registry = setup();
    state.scopeContext = null;
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectKnowledgeSettings />
      </RegistryContext.Provider>,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("opens a read-only file preview on click", async () => {
    const registry = setup();

    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectKnowledgeSettings />
      </RegistryContext.Provider>,
    );

    await expect.element(page.getByText("architecture.md")).toBeVisible();
    await expect.element(page.getByText(/2 KB/)).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /^architecture.md/ }));
    await expect.element(page.getByText(/Read-only knowledge body/)).toBeVisible();
  });

  it("deletes a knowledge file after confirmation", async () => {
    const registry = setup();
    state.deleteKnowledge.mockImplementation(async () => {
      state.listResult = AsyncResult.success({ projectId, files: [] });
      registry.refresh(listAtom);
      return { _tag: "Success", value: { projectId, name: "architecture.md", deleted: true } };
    });

    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectKnowledgeSettings />
      </RegistryContext.Provider>,
    );

    await userEvent.click(page.getByRole("button", { name: "Delete architecture.md" }));
    await expect
      .element(page.getByText("Remove architecture.md from this project's knowledge files?"))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Delete", exact: true }));

    await vi.waitFor(() => {
      expect(state.deleteKnowledge).toHaveBeenCalledWith({
        environmentId: envId,
        input: { projectId, name: "architecture.md" },
      });
    });
    await expect
      .element(
        page.getByText(
          "No knowledge files yet. Drag and drop files here or click Add files to upload.",
        ),
      )
      .toBeVisible();
  });

  it("uploads text and PDF files (as .md) while rejecting unsupported and oversized files", async () => {
    const registry = setup();
    state.extractPdf.mockResolvedValue("# Spec\nExtracted PDF text");
    state.addKnowledge.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: {
        projectId,
        name: input.name,
        sizeBytes: new TextEncoder().encode(input.content).byteLength,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    }));

    await using _screen = await render(
      <RegistryContext.Provider value={registry}>
        <ProjectKnowledgeSettings />
      </RegistryContext.Provider>,
    );

    const input = page.getByLabelText("Choose knowledge files");
    const validText = new File(["const x = 1;"], "notes.ts", { type: "text/plain" });
    const pdfFile = new File([new Uint8Array([1, 2, 3])], "design.pdf", {
      type: "application/pdf",
    });
    const unsupportedFile = new File([new Uint8Array([0, 1])], "image.png", {
      type: "image/png",
    });
    const oversizedFile = new File(["x".repeat(PROJECT_KNOWLEDGE_FILE_MAX_BYTES + 1)], "big.txt", {
      type: "text/plain",
    });

    await userEvent.upload(input, [validText, pdfFile, unsupportedFile, oversizedFile]);

    await vi.waitFor(() => {
      expect(state.addKnowledge).toHaveBeenCalledTimes(2);
    });
    expect(state.addKnowledge).toHaveBeenNthCalledWith(1, {
      environmentId: envId,
      input: { projectId, name: "notes.ts", content: "const x = 1;" },
    });
    expect(state.addKnowledge).toHaveBeenNthCalledWith(2, {
      environmentId: envId,
      input: { projectId, name: "design.pdf.md", content: "# Spec\nExtracted PDF text" },
    });

    await expect
      .element(page.getByText("image.png is not a supported text, code, or PDF file."))
      .toBeVisible();
    await expect.element(page.getByText(/big.txt exceeds the .* file size limit/)).toBeVisible();
  });
});
