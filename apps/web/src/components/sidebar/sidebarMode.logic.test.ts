import type { ThreadModeSource } from "@t3tools/client-runtime/state/thread-mode";
import { describe, expect, it } from "vite-plus/test";

import {
  filterThreadSidebarThreads,
  resolveSidebarEffectiveMode,
  resolveSidebarRouteKey,
} from "./sidebarMode.logic";

describe("sidebarMode.logic", () => {
  it("derives a stable route key from project, thread, or draft routes", () => {
    expect(
      resolveSidebarRouteKey({
        activeProjectKey: "proj-a",
        activeThreadKey: "env:t1",
        activeDraftId: "d1",
      }),
    ).toBe("proj-a");
    expect(
      resolveSidebarRouteKey({
        activeProjectKey: null,
        activeThreadKey: "env:t1",
        activeDraftId: "d1",
      }),
    ).toBe("env:t1");
    expect(
      resolveSidebarRouteKey({
        activeProjectKey: null,
        activeThreadKey: null,
        activeDraftId: "d1",
      }),
    ).toBe("draft:d1");
    expect(
      resolveSidebarRouteKey({
        activeProjectKey: null,
        activeThreadKey: null,
        activeDraftId: null,
      }),
    ).toBe("");
  });

  it("selects Bots on bot routes, honors same-route overrides, and falls back when Bots are off", () => {
    expect(
      resolveSidebarEffectiveMode({
        savedMode: "all",
        botsEnabled: true,
        isBotRoute: true,
        routeKey: "env:bot-1",
        tabOverride: null,
      }),
    ).toBe("bots");

    expect(
      resolveSidebarEffectiveMode({
        savedMode: "all",
        botsEnabled: true,
        isBotRoute: true,
        routeKey: "env:bot-1",
        tabOverride: { routeKey: "env:bot-1", mode: "work" },
      }),
    ).toBe("work");

    // Stale override from another route does not suppress Bots selection on a new bot route.
    expect(
      resolveSidebarEffectiveMode({
        savedMode: "all",
        botsEnabled: true,
        isBotRoute: true,
        routeKey: "env:bot-2",
        tabOverride: { routeKey: "env:bot-1", mode: "work" },
      }),
    ).toBe("bots");

    expect(
      resolveSidebarEffectiveMode({
        savedMode: "bots",
        botsEnabled: false,
        isBotRoute: true,
        routeKey: "env:bot-1",
        tabOverride: null,
      }),
    ).toBe("all");
  });

  it("filters thread sidebar entries by mode tag and empties them on the Bots tab", () => {
    type TestThread = ThreadModeSource & { readonly id: string };
    const codeThread: TestThread = { id: "code", source: { tags: [] } };
    const untaggedThread: TestThread = { id: "untagged" };
    const workThread: TestThread = { id: "work", tags: ["mode:work"] };
    const threads: ReadonlyArray<TestThread> = [codeThread, untaggedThread, workThread];

    expect(filterThreadSidebarThreads(threads, "all")).toBe(threads);
    expect(filterThreadSidebarThreads(threads, "code")).toEqual([codeThread, untaggedThread]);
    expect(filterThreadSidebarThreads(threads, "work")).toEqual([workThread]);
    expect(filterThreadSidebarThreads(threads, "bots")).toEqual([]);
    expect(filterThreadSidebarThreads(threads, "bots", true)).toBe(threads);
  });
});
