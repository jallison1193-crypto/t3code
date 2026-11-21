import { EnvironmentId, ProjectId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  libraryPageView,
  librarySources,
  loadLibraryPages,
  startLibrary,
} from "./htmlLibraryPages";

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

function entry(day: number, id: string, attachmentId = id) {
  return {
    ...candidate(day, id),
    attachmentId,
    title: id,
    height: 500,
    projectId,
    projectTitle: "Project",
    threadId,
    threadTitle: "Thread",
    mode: "work" as const,
  };
}

it("keeps a stable merged prefix across empty pages, overlapping attachments and failed hosts", async () => {
  const read = vi.fn<Parameters<typeof loadLibraryPages>[2]>();
  read
    .mockResolvedValueOnce({
      entries: [entry(21, "new", "shared"), entry(17, "older")],
      nextCursor: candidate(17, "older"),
    })
    .mockResolvedValueOnce({ entries: [], nextCursor: candidate(19, "candidate") })
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce({ entries: [entry(16, "duplicate", "shared")], nextCursor: null })
    .mockResolvedValueOnce({
      entries: [entry(18, "remote", "shared")],
      nextCursor: candidate(15, "candidate"),
    })
    .mockResolvedValueOnce({ entries: [], nextCursor: null });

  const initial = startLibrary([
    { environmentId: first },
    { environmentId: second },
    { environmentId: offline },
  ]);
  const page1 = await loadLibraryPages(initial, "work", read);
  expect(libraryPageView(page1)).toMatchObject({
    entries: [{ title: "new", environmentId: first }],
    hasMore: true,
    unavailable: [offline],
  });

  const page2 = await loadLibraryPages(page1, "work", read);
  expect(
    libraryPageView(page2).entries.map(({ title, environmentId }) => [title, environmentId]),
  ).toEqual([
    ["new", first],
    ["remote", second],
    ["older", first],
  ]);
  expect(read.mock.calls.slice(3)).toEqual([
    [first, { mode: "work", cursor: candidate(17, "older") }],
    [second, { mode: "work", cursor: candidate(19, "candidate") }],
  ]);

  const page3 = await loadLibraryPages(page2, "work", read);
  expect(libraryPageView(page3)).toEqual({
    entries: libraryPageView(page2).entries,
    hasMore: false,
    unavailable: [offline],
  });
});

it("sends only the physical project IDs belonging to each environment", async () => {
  const secondProject = ProjectId.make("other");
  const sources = librarySources([
    { environmentId: first, id: projectId },
    { environmentId: second, id: projectId },
    { environmentId: second, id: projectId },
    { environmentId: second, id: secondProject },
  ]);
  const read = vi.fn().mockResolvedValue({ entries: [], nextCursor: null });
  await loadLibraryPages(startLibrary(sources), "code", read);
  expect(read.mock.calls).toEqual([
    [first, { mode: "code", projectIds: [projectId] }],
    [second, { mode: "code", projectIds: [secondProject, projectId] }],
  ]);
});
