import { EnvironmentId, ProjectId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { HtmlLibraryPage } from "./HtmlLibraryPage";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const offline = EnvironmentId.make("offline");
const mocks = vi.hoisted(() => ({ read: vi.fn(), asset: vi.fn() }));

vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.read,
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
  const before = getClientSettings();
  __setClientSettingsForTests({ ...before, appMode: "code", sidebarModeFilter: "all" });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(before) };
}

it("loads on opening, keeps partial results, and resolves the preview on its source host", async () => {
  using _settings = setup();
  const cursor = { updatedAt: "2026-11-20T00:00:00.000Z", itemId: TurnItemId.make("item") };
  mocks.read
    .mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Unknown RPC") })
    .mockResolvedValueOnce({ _tag: "Success", value: { entries: [], nextCursor: cursor } })
    .mockResolvedValueOnce({
      _tag: "Success",
      value: {
        entries: [
          {
            ...cursor,
            updatedAt: "2026-11-19T00:00:00.000Z",
            attachmentId: "attachment",
            title: "Quarterly chart",
            height: 300,
            mode: "work",
            threadId: ThreadId.make("source"),
            threadTitle: "Analysis",
            projectId: ProjectId.make("reports"),
            projectTitle: "Reports",
          },
        ],
        nextCursor: null,
      },
    })
    .mockResolvedValue({ _tag: "Success", value: { entries: [], nextCursor: null } });
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
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Load more" }));
  await expect.element(screen.getByText("Quarterly chart")).toBeVisible();
  expect(mocks.read.mock.calls[2]?.[0]).toEqual({
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
  await expect
    .element(dialog.getByTitle("Quarterly chart"))
    .toHaveAttribute("src", /^https:\/\/build-machine\.test\/attachment\.html(?:#|$)/);
  await expect
    .element(dialog.getByTitle("Quarterly chart"))
    .toHaveAttribute("sandbox", "allow-scripts allow-forms");
  expect(mocks.asset.mock.calls[0]?.[0]).toBe(remote);
  await userEvent.click(dialog.getByRole("button", { name: "Close" }));
  await expect.element(dialog).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Work", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Work", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(getClientSettings()).toMatchObject({ appMode: "code", sidebarModeFilter: "work" });
  await expect
    .element(screen.getByText("No HTML pages found in available environments."))
    .toBeVisible();
  expect(mocks.read.mock.calls.slice(3).map(([target]) => target.input)).toEqual([
    { mode: "work" },
    { mode: "work" },
  ]);
});
