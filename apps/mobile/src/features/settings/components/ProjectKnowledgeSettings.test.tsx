import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type ProjectKnowledgeAddResult,
  type ProjectKnowledgeDeleteResult,
  type ProjectKnowledgeGetResult,
  type ProjectKnowledgeListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ButtonProps = {
  label: string;
  disabled?: boolean;
  onPress: () => void;
};

type PressableProps = {
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress?: () => void;
  children?: ReactNode;
};

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("proj-1");

const state = vi.hoisted(() => ({
  buttons: new Map<string, ButtonProps>(),
  pressables: new Map<string, PressableProps>(),
  confirmRequests: [] as Array<{ title: string; message?: string; onConfirm: () => void }>,
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
  pickResult: {
    canceled: false,
    assets: [] as Array<{
      name: string;
      uri: string;
      mimeType?: string;
      size?: number;
      file?: { text: () => Promise<string> };
    }>,
  },
  fileTextByUri: new Map<string, string>(),
}));

const listAtom = Atom.make(() => state.listResult);
const detailAtom = Atom.make(() => state.detailResult);
const canAddAtom = Atom.make(() => state.canAdd);
const canDeleteAtom = Atom.make(() => state.canDelete);

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <div data-testid="modal">{children}</div> : null,
  Pressable: (props: PressableProps) => {
    if (props.accessibilityLabel) state.pressables.set(props.accessibilityLabel, props);
    return <div>{props.children}</div>;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (text: string, vars?: Record<string, unknown>) =>
    vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : text,
}));
vi.mock("../../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span>loading</span>,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({
  SymbolView: () => null,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    state.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../../components/ui/Dialog", () => ({
  confirm: (req: { title: string; message?: string; onConfirm: () => void }) => {
    state.confirmRequests.push(req);
  },
}));
vi.mock("../../../lib/foreground-handoff", () => ({
  beginForegroundHandoff: () => () => {},
}));
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: async () => state.pickResult,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private readonly uri: string) {}
    async text() {
      return state.fileTextByUri.get(this.uri) ?? "";
    }
  },
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
vi.mock("../../../state/projects", () => ({
  projectEnvironment: {
    knowledgeList: () => listAtom,
    knowledgeGet: () => detailAtom,
    knowledgeAdd: {
      __cmd: "add",
      permissionAtom: () => canAddAtom,
    },
    knowledgeDelete: {
      __cmd: "delete",
      permissionAtom: () => canDeleteAtom,
    },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly __cmd?: string }) =>
    command?.__cmd === "add" ? state.addKnowledge : state.deleteKnowledge,
}));

import { ProjectKnowledgeSettings } from "./ProjectKnowledgeSettings";

let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;

function render(connected = true) {
  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <ProjectKnowledgeSettings
          environmentId={envId}
          projectId={projectId}
          connected={connected}
        />
      </RegistryContext.Provider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  registry = AtomRegistry.make();
  state.buttons.clear();
  state.pressables.clear();
  state.confirmRequests = [];
  state.canAdd = true;
  state.canDelete = true;
  state.listResult = AsyncResult.success({
    projectId,
    files: [
      {
        name: "notes.md",
        sizeBytes: 512,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  state.detailResult = AsyncResult.success({
    projectId,
    name: "notes.md",
    content: "# Notes\nMobile knowledge content",
    startLine: 1,
    endLine: 2,
    totalLines: 2,
    sizeBytes: 31,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  state.addKnowledge.mockReset();
  state.deleteKnowledge.mockReset();
  state.fileTextByUri.clear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("mobile ProjectKnowledgeSettings", () => {
  it("shows reconnect message when disconnected", () => {
    render(false);
    expect(container.textContent).toContain(
      "Connect this machine to view and manage knowledge files.",
    );
  });

  it("opens preview modal and confirms deletion", async () => {
    state.deleteKnowledge.mockResolvedValueOnce({
      _tag: "Success",
      value: { projectId, name: "notes.md", deleted: true },
    });

    render(true);
    expect(container.textContent).toContain("notes.md");

    act(() => state.pressables.get("notes.md")!.onPress?.());
    expect(container.textContent).toContain("Mobile knowledge content");

    act(() => state.buttons.get("Close")!.onPress());
    expect(container.textContent).not.toContain("Mobile knowledge content");

    act(() => state.pressables.get("Delete notes.md")!.onPress?.());
    expect(state.confirmRequests).toHaveLength(1);
    await act(async () => {
      state.confirmRequests[0]!.onConfirm();
    });
    expect(state.deleteKnowledge).toHaveBeenCalledWith({
      environmentId: envId,
      input: { projectId, name: "notes.md" },
    });
  });

  it("uploads text files via document picker and rejects PDFs cleanly on mobile", async () => {
    state.fileTextByUri.set("file:///tmp/guide.md", "# Mobile Guide");
    state.pickResult = {
      canceled: false,
      assets: [
        { name: "guide.md", uri: "file:///tmp/guide.md", mimeType: "text/markdown", size: 14 },
        {
          name: "manual.pdf",
          uri: "file:///tmp/manual.pdf",
          mimeType: "application/pdf",
          size: 100,
        },
      ],
    };
    state.addKnowledge.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        projectId,
        name: "guide.md",
        sizeBytes: 14,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    render(true);
    await act(async () => {
      state.buttons.get("Add files")!.onPress();
    });

    expect(state.addKnowledge).toHaveBeenCalledTimes(1);
    expect(state.addKnowledge).toHaveBeenCalledWith({
      environmentId: envId,
      input: { projectId, name: "guide.md", content: "# Mobile Guide" },
    });
    expect(container.textContent).toContain("PDF text extraction is only available on web");
  });
});
