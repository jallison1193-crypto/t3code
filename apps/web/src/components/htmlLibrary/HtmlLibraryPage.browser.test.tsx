import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { HtmlLibraryPage } from "./HtmlLibraryPage";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const offline = EnvironmentId.make("offline");
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  asset: vi.fn(),
  updateSettings: vi.fn(),
  editable: new Set<EnvironmentId>(),
}));

vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.read,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));

vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  useEnvironmentsWithScope: () => mocks.editable,
}));

vi.mock("~/assets/longLivedAssetUrls", () => ({
  useLongLivedAssetUrl: mocks.asset,
}));

vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useConnectedEnvironmentIds: () => [primary, remote],
  useEnvironments: () => ({
    isReady: true,
    environments: [
      { environmentId: primary, label: "Local" },
      { environmentId: remote, label: "Build machine" },
      { environmentId: offline, label: "Offline machine" },
    ],
    presentationById: new Map(),
    networkStatus: "online",
  }),
}));

function setup() {
  mocks.read.mockReset();
  mocks.asset.mockReset();
  mocks.updateSettings.mockReset();
  mocks.editable = new Set();
  const before = getClientSettings();
  __setClientSettingsForTests({ ...before, appMode: "code", sidebarModeFilter: "all" });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(before) };
}

it("loads on opening, keeps partial results, and resolves the preview on its source host", async () => {
  using _settings = setup();
  const cursor = { updatedAt: "2026-11-20T00:00:00.000Z", itemId: TurnItemId.make("item") };
  const chartEntry = {
    ...cursor,
    updatedAt: "2026-11-19T00:00:00.000Z",
    attachmentId: "attachment",
    title: "Quarterly chart",
    height: 300,
    mode: "work" as const,
    pinned: false,
    threadId: ThreadId.make("source"),
    threadTitle: "Analysis",
    projectId: ProjectId.make("reports"),
    projectTitle: "Reports",
  };
  mocks.read.mockImplementation(async ({ environmentId, input }) => {
    if (environmentId === primary && input.mode === "all") {
      return { _tag: "Failure", cause: new Error("Unknown RPC") };
    }
    if (environmentId === remote && input.mode === "all" && !input.pinned && !input.cursor) {
      return { _tag: "Success", value: { entries: [], nextCursor: cursor } };
    }
    if (environmentId === remote && input.mode === "all" && input.cursor) {
      return { _tag: "Success", value: { entries: [chartEntry], nextCursor: null } };
    }
    return { _tag: "Success", value: { entries: [], nextCursor: null } };
  });
  mocks.asset.mockReturnValue({
    _tag: "Success",
    url: "https://build-machine.test/attachment.html",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });

  await using screen = await render(
    <SidebarProvider>
      <div>Thread</div>
    </SidebarProvider>,
  );
  expect(mocks.read).not.toHaveBeenCalled();
  await screen.rerender(
    <SidebarProvider>
      <HtmlLibraryPage />
    </SidebarProvider>,
  );
  await expect.element(screen.getByText("Keep searching to see more results.")).toBeVisible();
  await expect
    .element(screen.getByText("Library unavailable on Offline machine, Local."))
    .toBeVisible();
  expect(mocks.read.mock.calls.map(([target]) => target)).toEqual([
    { environmentId: primary, input: { mode: "all" } },
    { environmentId: remote, input: { mode: "all" } },
    { environmentId: primary, input: { mode: "all", pinned: true } },
    { environmentId: remote, input: { mode: "all", pinned: true } },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByText("Quarterly chart")).toBeVisible();
  expect(mocks.read.mock.calls[4]?.[0]).toEqual({
    environmentId: remote,
    input: { mode: "all", cursor },
  });
  await expect
    .element(screen.getByRole("link", { name: "Open source thread" }))
    .toHaveAttribute("href", "/remote/source");
  expect(mocks.asset).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: /Quarterly chart/ }));
  const dialog = page.getByRole("dialog", { name: "Expanded Quarterly chart preview" });
  await expect.element(dialog).toBeVisible();
  const iframe = dialog.getByTitle("Quarterly chart");
  await expect.element(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  expect(iframe.element().getAttribute("src")?.split("#")[0]).toBe(
    "https://build-machine.test/attachment.html",
  );
  expect(mocks.asset.mock.calls[0]?.[0]).toBe(remote);
  await userEvent.click(dialog.getByRole("button", { name: "Close" }));
  await expect.element(dialog).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Work", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Work", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  // The Library's filter is its own: the sidebar's stays where it was.
  expect(getClientSettings()).toMatchObject({ appMode: "code", sidebarModeFilter: "all" });
  await expect.element(screen.getByText("Nothing matches this filter")).toBeVisible();
  expect(mocks.read.mock.calls.slice(5).map(([target]) => target.input)).toEqual([
    { mode: "work" },
    { mode: "work" },
    { mode: "work", pinned: true },
    { mode: "work", pinned: true },
  ]);
});

it("pins and unpins a page into the Pinned section and hides it from the recent list", async () => {
  using _settings = setup();
  mocks.editable = new Set([remote]);
  let pinnedAt: string | undefined;
  const makeEntries = () => [
    {
      updatedAt: "2026-11-20T00:00:00.000Z",
      itemId: TurnItemId.make("item-pin"),
      attachmentId: "pin-att",
      title: "Architecture diagram",
      height: 300,
      mode: "code" as const,
      pinned: pinnedAt !== undefined,
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
      threadId: ThreadId.make("thread-pin"),
      threadTitle: "Design",
      projectId: ProjectId.make("app"),
      projectTitle: "App",
    },
    {
      updatedAt: "2026-11-19T00:00:00.000Z",
      itemId: TurnItemId.make("item-other"),
      attachmentId: "other-att",
      title: "Latency table",
      height: 300,
      mode: "code" as const,
      pinned: false,
      threadId: ThreadId.make("thread-other"),
      threadTitle: "Perf",
      projectId: ProjectId.make("app"),
      projectTitle: "App",
    },
  ];
  mocks.read.mockImplementation(async ({ environmentId, input }) => {
    if (environmentId !== remote) {
      return { _tag: "Success", value: { entries: [], nextCursor: null } };
    }
    const entries = makeEntries();
    return {
      _tag: "Success",
      value: {
        entries: input.pinned ? entries.filter((entry) => entry.pinned) : entries,
        nextCursor: null,
      },
    };
  });
  mocks.updateSettings.mockImplementation(async ({ input }) => {
    const patchEntry = input.patch.htmlLibraryEntries?.["pin-att"];
    pinnedAt = patchEntry?.pinnedAt;
    return {
      _tag: "Success",
      value: {
        ...DEFAULT_SERVER_SETTINGS,
        htmlLibraryEntries: patchEntry ? { "pin-att": patchEntry } : {},
      },
    };
  });

  await using screen = await render(
    <SidebarProvider>
      <HtmlLibraryPage />
    </SidebarProvider>,
  );

  await expect.element(screen.getByText("Architecture diagram")).toBeVisible();
  await expect.element(screen.getByText("Latency table")).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Pinned" })).not.toBeInTheDocument();

  const actionButtons = screen.getByRole("button", { name: "Page actions" });
  await userEvent.click(actionButtons.nth(0));
  await userEvent.click(page.getByRole("menuitem", { name: "Pin" }));

  await expect.element(screen.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Recent" })).toBeVisible();
  expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
  expect(mocks.updateSettings.mock.calls[0]?.[0]).toMatchObject({
    environmentId: remote,
    input: {
      patch: {
        htmlLibraryEntries: {
          "pin-att": {
            threadId: ThreadId.make("thread-pin"),
            itemId: TurnItemId.make("item-pin"),
            pinnedAt: expect.any(String),
          },
        },
      },
    },
  });
  // Pinned entry appears once (in Pinned) and is hidden from Recent below it.
  expect(screen.getByRole("button", { name: /Architecture diagram/ }).elements()).toHaveLength(1);
  expect(screen.getByRole("button", { name: /Latency table/ }).elements()).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Page actions" }).nth(0));
  await userEvent.click(page.getByRole("menuitem", { name: "Unpin" }));
  await expect.element(screen.getByRole("heading", { name: "Pinned" })).not.toBeInTheDocument();
  expect(mocks.updateSettings.mock.calls[1]?.[0]).toEqual({
    environmentId: remote,
    input: { patch: { htmlLibraryEntries: { "pin-att": null } } },
  });
  expect(screen.getByRole("button", { name: /Architecture diagram/ }).elements()).toHaveLength(1);
});

it("switches to Files via URL search param and opens workspace files in the source thread", async () => {
  using _settings = setup();
  mocks.read.mockImplementation(async ({ environmentId }) => {
    if (environmentId !== remote) {
      return { _tag: "Success", value: { entries: [], nextCursor: null } };
    }
    return {
      _tag: "Success",
      value: {
        entries: [
          {
            path: "C:\\work\\budget\\reports\\q4.xlsx",
            fileName: "q4.xlsx",
            itemId: TurnItemId.make("item-in"),
            threadId: ThreadId.make("thread-budget"),
            threadTitle: "Q4 budget",
            projectId: ProjectId.make("proj-budget"),
            projectTitle: "Finance",
            workspaceRoot: "C:\\work\\budget",
            mode: "work" as const,
            updatedAt: "2026-11-22T20:00:00.000Z",
          },
          {
            path: "C:\\outside\\scratch.txt",
            fileName: "scratch.txt",
            itemId: TurnItemId.make("item-out"),
            threadId: ThreadId.make("thread-budget"),
            threadTitle: "Q4 budget",
            projectId: ProjectId.make("proj-budget"),
            projectTitle: "Finance",
            workspaceRoot: "C:\\work\\budget",
            mode: "work" as const,
            updatedAt: "2026-11-22T19:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    };
  });

  await using screen = await render(
    <SidebarProvider>
      <HtmlLibraryPage />
    </SidebarProvider>,
    { router: "/library" },
  );
  using openFileSpy = vi.spyOn(useRightPanelStore.getState(), "openFile");

  await userEvent.click(screen.getByRole("button", { name: "Files", exact: true }));
  await expect.element(screen.getByText("q4.xlsx")).toBeVisible();
  await expect.element(screen.getByText("reports")).toBeVisible();
  await expect.element(screen.getByText("scratch.txt")).toBeVisible();
  expect(screen.router?.state.location.searchStr).toBe("?view=files");

  const threadLinks = screen.getByRole("link", { name: "Open source thread" }).elements();
  expect(threadLinks).toHaveLength(2);
  expect(threadLinks[0]?.getAttribute("href")).toBe("/remote/thread-budget");

  await userEvent.click(screen.getByRole("button", { name: /q4\.xlsx/ }));
  expect(openFileSpy).toHaveBeenCalledWith(
    { environmentId: remote, threadId: ThreadId.make("thread-budget") },
    "reports/q4.xlsx",
  );
  expect(screen.router?.state.location.pathname).toBe("/remote/thread-budget");
});
