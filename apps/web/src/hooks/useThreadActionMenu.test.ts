import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ContextMenuItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadActionMenuId } from "../components/threadActionMenu.logic";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  granted: new Set<string>(),
  effects: [] as string[],
  tags: [] as string[],
  setTagCalls: [] as Array<unknown>,
  setTagResult: null as AsyncResult.AsyncResult<unknown, unknown> | null,
  toasts: [] as Array<unknown>,
  completed: deferred<void>(),
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
  state.completed.resolve();
}

vi.mock("../components/CustomSnoozeDialog", () => ({ requestCustomSnooze: vi.fn() }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: async () => recordEffect("project-settings") }),
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.granted.has(environmentId),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readThreadShell: () => ({
    id: "thread",
    environmentId: "secondary",
    projectId: "project",
    title: "Thread",
    branch: "main",
    worktreePath: null,
    runtime: null,
    latestRun: null,
    source: { tags: state.tags },
  }),
  useProjects: () => [{ id: "project", environmentId: "secondary" }],
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: "metadata", setTag: "setTag" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => async (payload: unknown) => {
    if (command === "setTag") {
      state.setTagCalls.push(payload);
      const result = state.setTagResult ?? AsyncResult.success(undefined);
      if (result._tag === "Success") {
        recordEffect("setTag");
      }
      return result;
    }
    recordEffect("metadata");
    return AsyncResult.success(undefined);
  },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.show, close: () => {} },
    dialogs: {
      confirm: async () => {
        recordEffect("confirm");
        return false;
      },
    },
  }),
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "project",
  derivePhysicalProjectKey: () => "project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../sidebarProjectGrouping", () => ({
  buildPhysicalToLogicalProjectKeyMap: () => new Map(),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadUnread: () => recordEffect("mark-unread"),
    }),
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: unknown) => {
      state.toasts.push(toast);
      state.completed.resolve();
    },
  },
}));
vi.mock("../components/Sidebar.snooze", () => ({
  resolveSnoozePresets: () => [
    { id: "hour", label: "In 1 hour", whenLabel: "3 PM", snoozedUntil: "2099-01-01T00:00:00Z" },
  ],
  snoozeWakeDescription: () => "later",
}));
vi.mock("./useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: () => recordEffect("copy") }),
}));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => recordEffect("draft"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      timestampFormat: "12-hour",
    }),
}));
vi.mock("./useThreadActions", () => ({
  canTurnThreadIntoProject: () => false,
  useThreadActions: () =>
    Object.fromEntries(
      [
        "markThreadUnread",
        "settleThread",
        "unsettleThread",
        "snoozeThread",
        "unsnoozeThread",
        "pinThread",
        "confirmAndUnpinThread",
        "archiveThread",
        "deleteThread",
      ].map((action) => [
        action,
        async () => {
          recordEffect(action === "markThreadUnread" ? "mark-unread" : action);
          return AsyncResult.success(undefined);
        },
      ]),
    ),
}));

vi.mock("./useCoordinatorThreadActions", () => ({
  readCoordinatorMenuState: () => ({ supported: true, isCoordinator: false }),
  useCoordinatorThreadActions: () => ({
    makeCoordinatorThread: async () => recordEffect("make-coordinator"),
    removeCoordinatorThread: async () => recordEffect("remove-coordinator"),
  }),
}));

import { useThreadActionMenu } from "./useThreadActionMenu";

const target = {
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
};
const position = { x: 10, y: 20 };
const createMenu = (options: { readonly onFind?: (threadRef: typeof target) => void } = {}) =>
  useThreadActionMenu({
    threadRef: target,
    projectCwd: "/project",
    onStartRename: () => recordEffect("rename"),
    onFind: options.onFind,
    canShareWithGuest: false,
  });

beforeEach(() => {
  state.granted = new Set(["primary"]);
  state.effects = [];
  state.tags = [];
  state.setTagCalls = [];
  state.setTagResult = null;
  state.toasts = [];
  state.completed = deferred<void>();
  state.show.mockReset().mockResolvedValue(null);
});

describe("thread menu permissions", () => {
  it.each([
    "rename",
    "regenerate-title",
    "delete",
    "pin",
    "settle",
    "archive",
    "move-to-work",
    "move-to-code",
  ] as const)("%s rechecks after the native menu closes", async (action) => {
    state.granted.add("secondary");
    const choice = deferred<ThreadActionMenuId | null>();
    state.show.mockReturnValue(choice.promise);
    createMenu().openMenu(position);
    state.granted.delete("secondary");
    choice.resolve(action);
    await state.completed.promise;
    expect(state.effects).toEqual([]);
  });

  it("moves a Code thread to Work and a Work thread to Code independently of appMode", async () => {
    state.granted.add("secondary");
    state.show.mockResolvedValue("move-to-work");
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.show.mock.calls[0]![0].find((item) => item.id === "move-to-work")).toEqual({
      id: "move-to-work",
      label: "Move to Work",
    });
    expect(state.setTagCalls).toEqual([
      {
        environmentId: target.environmentId,
        input: { threadId: target.threadId, tag: "mode:work", tagged: true },
      },
    ]);

    state.tags = ["mode:work"];
    state.setTagCalls = [];
    state.completed = deferred<void>();
    state.show.mockResolvedValue("move-to-code");
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.show.mock.calls[1]![0].find((item) => item.id === "move-to-code")).toEqual({
      id: "move-to-code",
      label: "Move to Code",
    });
    expect(state.setTagCalls).toEqual([
      {
        environmentId: target.environmentId,
        input: { threadId: target.threadId, tag: "mode:work", tagged: false },
      },
    ]);
  });

  it("shows an error toast when moving a thread between modes fails", async () => {
    state.granted.add("secondary");
    state.setTagResult = AsyncResult.failure(Cause.fail(new Error("tag write failed")));
    state.show.mockResolvedValue("move-to-work");
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.toasts).toContainEqual(
      expect.objectContaining({
        type: "error",
        title: "Failed to move thread",
        description: "tag write failed",
      }),
    );
  });

  it("offers find only to a header that can open it, without task permission", async () => {
    createMenu().openMenu(position);
    expect(state.show.mock.calls[0]![0].some((item) => item.id === "find")).toBe(false);
    state.show.mockResolvedValue("find");
    const onFind = vi.fn(() => recordEffect("find"));
    createMenu({ onFind }).openMenu(position);
    await state.completed.promise;
    const items = state.show.mock.calls[1]![0];
    expect(items[0]).toMatchObject({ id: "find", label: "Find in thread" });
    expect(items[0]?.disabled).not.toBe(true);
    expect(state.effects).toEqual(["find"]);
    expect(onFind).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("runs make-coordinator without task operate permission", async () => {
    state.show.mockResolvedValue("make-coordinator");
    createMenu().openMenu(position);
    await state.completed.promise;
    expect(state.effects).toEqual(["make-coordinator"]);
  });
});
