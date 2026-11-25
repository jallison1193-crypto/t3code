import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundsDiffer,
  companionBounds,
  companionClickThrough,
  keepInWorkArea,
  savedBoundsFor,
} from "./DesktopCompanionWindow.logic.ts";

// A second monitor to the left of the primary one, with a taskbar at the bottom.
const workArea = { x: -1920, y: 40, width: 1920, height: 1040 };

describe("companionBounds", () => {
  it.each([
    ["bottom-right", "medium", { x: -396, y: 524, width: 380, height: 540 }],
    ["bottom-left", "medium", { x: -1904, y: 524, width: 380, height: 540 }],
    ["right", "medium", { x: -396, y: 56, width: 380, height: 1008 }],
    ["left", "large", { x: -1904, y: 56, width: 640, height: 1008 }],
    ["right", "small", { x: -88, y: 524, width: 72, height: 72 }],
    ["bottom-right", "small", { x: -88, y: 992, width: 72, height: 72 }],
  ] as const)("places %s %s", (position, size, expected) => {
    expect(companionBounds({ position, size, workArea })).toEqual(expected);
  });

  it("shrinks to fit a work area smaller than the size", () => {
    expect(
      companionBounds({
        position: "bottom-right",
        size: "large",
        workArea: { x: 0, y: 0, width: 600, height: 500 },
      }),
    ).toEqual({ x: 16, y: 16, width: 568, height: 468 });
  });
});

describe("keepInWorkArea", () => {
  it("pulls a window left on a removed display back onto this one", () => {
    expect(keepInWorkArea({ x: 2400, y: -200, width: 380, height: 540 }, workArea)).toEqual({
      x: -380,
      y: 40,
      width: 380,
      height: 540,
    });
  });
});

describe("boundsDiffer", () => {
  it("ignores rounding and reports a real move", () => {
    const home = { x: 10, y: 10, width: 380, height: 540 };
    expect(boundsDiffer(home, { ...home, x: 12, height: 538 })).toBe(false);
    expect(boundsDiffer(home, { ...home, y: 13 })).toBe(true);
  });
});

describe("companionClickThrough", () => {
  const driving = {
    thread: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("a") },
    waitingOnUser: false,
  };

  it.each([
    ["during computer use", null, true, driving, true],
    ["outside computer use", null, true, null, false],
    ["while the thread waits for the user", null, true, { ...driving, waitingOnUser: true }, false],
    ["with the setting off", null, false, driving, false],
    ["after a toggle off", false, true, driving, false],
    ["after a toggle on", true, false, null, true],
  ] as const)("is decided %s", (_case, override, enabled, computerUse, expected) => {
    expect(companionClickThrough({ override, enabled, computerUse })).toBe(expected);
  });
});

describe("savedBoundsFor", () => {
  it("keeps dragged bounds only while Position and Size are unchanged", () => {
    const bounds = { x: 5, y: 6, width: 400, height: 500 };
    const saved = { position: "right", size: "medium", ...bounds } as const;
    const placement = { companionWindowPosition: "right", companionWindowSize: "medium" } as const;
    expect(savedBoundsFor(saved, placement)).toEqual(bounds);
    expect(savedBoundsFor(saved, { ...placement, companionWindowPosition: "left" })).toBeNull();
    expect(savedBoundsFor(saved, { ...placement, companionWindowSize: "large" })).toBeNull();
  });
});
