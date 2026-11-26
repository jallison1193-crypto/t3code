import { EnvironmentId, ProjectId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  hasAnyWorkThread,
  libraryFileOpenPath,
  libraryFilesView,
  libraryModeFromSearch,
  libraryUrlWithMode,
  libraryUrlWithView,
  libraryViewFromSearch,
  loadLibraryFiles,
  shouldShowLibraryModeFilter,
  splitLibraryFilePath,
  startLibraryFiles,
} from "./libraryFiles.logic";

const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const offline = EnvironmentId.make("offline");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");

function candidate(day: number, id: string) {
  return {
    updatedAt: `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    itemId: TurnItemId.make(id),
  };
}

function fileEntry(day: number, id: string, path: string, workspaceRoot?: string) {
  const fileName = path.split(/[\\/]/).at(-1) ?? path;
  return {
    ...candidate(day, id),
    path,
    fileName,
    projectId,
    projectTitle: "Project",
    threadId,
    threadTitle: "Thread",
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    mode: "work" as const,
  };
}

it("splits file names and parent folders relative to the workspace or absolute when outside", () => {
  expect(
    splitLibraryFilePath("C:\\Users\\josh\\budget\\reports\\q4.xlsx", "C:\\Users\\josh\\budget"),
  ).toEqual({
    fileName: "q4.xlsx",
    parentFolder: "reports",
  });
  expect(
    splitLibraryFilePath("C:\\Users\\josh\\budget\\summary.xlsx", "C:\\Users\\josh\\budget"),
  ).toEqual({
    fileName: "summary.xlsx",
    parentFolder: null,
  });
  expect(
    splitLibraryFilePath("C:\\Users\\josh\\Desktop\\notes.md", "C:\\Users\\josh\\budget"),
  ).toEqual({
    fileName: "notes.md",
    parentFolder: "C:\\Users\\josh\\Desktop",
  });
  expect(splitLibraryFilePath("/Users/josh/work/docs/plan.md", "/Users/josh/work")).toEqual({
    fileName: "plan.md",
    parentFolder: "docs",
  });
  expect(splitLibraryFilePath("/tmp/export.csv")).toEqual({
    fileName: "export.csv",
    parentFolder: "/tmp",
  });
  expect(splitLibraryFilePath("C:\\root.txt")).toEqual({
    fileName: "root.txt",
    parentFolder: "C:\\",
  });
});

it("resolves workspace-relative paths for Open and returns null outside the workspace", () => {
  expect(
    libraryFileOpenPath({
      path: "C:\\Users\\josh\\budget\\reports\\q4.xlsx",
      workspaceRoot: "C:\\Users\\josh\\budget",
    }),
  ).toBe("reports/q4.xlsx");
  expect(libraryFileOpenPath({ path: "/Users/josh/work/notes.md" }, "/Users/josh/work")).toBe(
    "notes.md",
  );
  expect(
    libraryFileOpenPath({
      path: "C:\\Users\\josh\\Desktop\\other.xlsx",
      workspaceRoot: "C:\\Users\\josh\\budget",
    }),
  ).toBeNull();
  expect(libraryFileOpenPath({ path: "/Users/josh/work/notes.md" }, undefined)).toBeNull();
});

it("reads and updates the view search param without losing other query params", () => {
  expect(libraryViewFromSearch("")).toBe("pages");
  expect(libraryViewFromSearch("?view=pages")).toBe("pages");
  expect(libraryViewFromSearch("?view=files")).toBe("files");
  expect(libraryViewFromSearch({ view: "files" })).toBe("files");
  expect(libraryUrlWithView("/library", "", "", "files")).toBe("/library?view=files");
  expect(libraryUrlWithView("/library", "?foo=1&view=files", "#top", "pages")).toBe(
    "/library?foo=1#top",
  );
  expect(libraryUrlWithView("/projects/demo/library", "?foo=1", "", "files")).toBe(
    "/projects/demo/library?foo=1&view=files",
  );
  expect(libraryModeFromSearch("")).toBe("all");
  expect(libraryModeFromSearch("?mode=bots")).toBe("all");
  expect(libraryModeFromSearch("?view=files&mode=work")).toBe("work");
  expect(libraryUrlWithMode("/library", "?view=files", "", "code")).toBe(
    "/library?view=files&mode=code",
  );
  expect(libraryUrlWithMode("/library", "?view=files&mode=code", "", "all")).toBe(
    "/library?view=files",
  );
});

it("merges file pages across environments, dedupes older duplicates, and tracks unavailable hosts", async () => {
  const read = vi.fn<Parameters<typeof loadLibraryFiles>[2]>();
  read
    .mockResolvedValueOnce({
      entries: [
        fileEntry(21, "new", "C:\\work\\budget.xlsx"),
        fileEntry(17, "older", "C:\\work\\notes.md"),
      ],
      nextCursor: candidate(17, "older"),
    })
    .mockResolvedValueOnce({ entries: [], nextCursor: candidate(19, "candidate") })
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce({
      entries: [fileEntry(16, "dup", "C:\\work\\BUDGET.xlsx")],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      entries: [fileEntry(18, "remote", "/repo/chart.csv")],
      nextCursor: null,
    });

  const initial = startLibraryFiles([
    { environmentId: first },
    { environmentId: second },
    { environmentId: offline },
  ]);
  const page1 = await loadLibraryFiles(initial, "work", read);
  expect(libraryFilesView(page1)).toMatchObject({
    entries: [{ fileName: "budget.xlsx", environmentId: first }],
    hasMore: true,
    unavailable: [offline],
  });

  const page2 = await loadLibraryFiles(page1, "work", read);
  expect(
    libraryFilesView(page2).entries.map(({ fileName, environmentId }) => [fileName, environmentId]),
  ).toEqual([
    ["budget.xlsx", first],
    ["chart.csv", second],
    ["notes.md", first],
  ]);
  expect(libraryFilesView(page2).hasMore).toBe(false);
});

it("advances past sparse empty file pages until it finds matches or exhausts the stream", async () => {
  const emptyRead = vi.fn<Parameters<typeof loadLibraryFiles>[2]>();
  emptyRead
    .mockResolvedValueOnce({ entries: [], nextCursor: candidate(20, "c1") })
    .mockResolvedValueOnce({ entries: [], nextCursor: candidate(19, "c2") })
    .mockResolvedValueOnce({ entries: [], nextCursor: null });

  const exhausted = await loadLibraryFiles(
    startLibraryFiles([{ environmentId: first }]),
    "work",
    emptyRead,
  );
  expect(emptyRead).toHaveBeenCalledTimes(3);
  expect(libraryFilesView(exhausted)).toEqual({
    entries: [],
    hasMore: false,
    unavailable: [],
  });

  const matchingRead = vi.fn<Parameters<typeof loadLibraryFiles>[2]>();
  matchingRead
    .mockResolvedValueOnce({ entries: [], nextCursor: candidate(20, "c1") })
    .mockResolvedValueOnce({
      entries: [fileEntry(18, "later", "/work/report.md")],
      nextCursor: candidate(17, "c2"),
    });

  const found = await loadLibraryFiles(
    startLibraryFiles([{ environmentId: first }]),
    "work",
    matchingRead,
  );
  expect(matchingRead).toHaveBeenCalledTimes(2);
  expect(libraryFilesView(found)).toMatchObject({
    entries: [{ fileName: "report.md", environmentId: first }],
    hasMore: true,
    unavailable: [],
  });

  // A stalled cursor terminates instead of looping forever.
  const stuckCursor = candidate(15, "stuck");
  const stuckRead = vi.fn<Parameters<typeof loadLibraryFiles>[2]>().mockResolvedValue({
    entries: [],
    nextCursor: stuckCursor,
  });
  const stuck = await loadLibraryFiles(
    startLibraryFiles([{ environmentId: first }]),
    "work",
    stuckRead,
  );
  expect(stuckRead).toHaveBeenCalledTimes(2);
  expect(libraryFilesView(stuck).hasMore).toBe(false);
});

it("shows the Library mode filter only when Work mode is on, a Work thread exists, or a mode is active", () => {
  expect(
    hasAnyWorkThread([
      { deletedAt: null, tags: [] },
      { deletedAt: "2026-11-20T00:00:00.000Z", tags: ["mode:work"] },
    ]),
  ).toBe(false);
  expect(hasAnyWorkThread([{ deletedAt: null, source: { tags: ["mode:work"] } }])).toBe(true);

  expect(shouldShowLibraryModeFilter({ appMode: "code", hasWorkThread: false, mode: "all" })).toBe(
    false,
  );
  expect(shouldShowLibraryModeFilter({ appMode: "work", hasWorkThread: false, mode: "all" })).toBe(
    true,
  );
  expect(shouldShowLibraryModeFilter({ appMode: "code", hasWorkThread: true, mode: "all" })).toBe(
    true,
  );
  expect(shouldShowLibraryModeFilter({ appMode: "code", hasWorkThread: false, mode: "work" })).toBe(
    true,
  );
});
