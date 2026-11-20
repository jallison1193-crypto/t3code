import { describe, expect, it } from "vite-plus/test";

import { filterThreadsByMode, threadModeOf, WORK_MODE_TAG } from "./threadMode.ts";

describe("threadMode", () => {
  it("resolves work mode from top-level or source tags and defaults to code", () => {
    expect(threadModeOf({})).toBe("code");
    expect(threadModeOf({ tags: [] })).toBe("code");
    expect(threadModeOf({ tags: ["urgent"] })).toBe("code");
    expect(threadModeOf({ tags: [WORK_MODE_TAG] })).toBe("work");
    expect(threadModeOf({ source: { tags: [WORK_MODE_TAG] } })).toBe("work");
    expect(threadModeOf({ source: { tags: ["other"] } })).toBe("code");
  });

  it("prefers top-level tags over source tags when both exist", () => {
    expect(
      threadModeOf({
        tags: [],
        source: { tags: [WORK_MODE_TAG] },
      }),
    ).toBe("code");
  });

  it("filters threads by mode while returning the original array for all", () => {
    const codeThread = { id: "code-1", source: { tags: [] } };
    const workThread = { id: "work-1", source: { tags: [WORK_MODE_TAG] } };
    const untaggedThread = { id: "code-2", tags: undefined };
    const threads = [codeThread, workThread, untaggedThread] as const;

    expect(filterThreadsByMode(threads, "all")).toBe(threads);
    expect(filterThreadsByMode(threads, "code")).toEqual([codeThread, untaggedThread]);
    expect(filterThreadsByMode(threads, "work")).toEqual([workThread]);
  });
});
