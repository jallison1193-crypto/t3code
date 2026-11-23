import { EnvironmentId, ProjectId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  libraryFileOpenPath,
  libraryFilesView,
  libraryUrlWithView,
  libraryViewFromSearch,
  loadLibraryFiles,
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
