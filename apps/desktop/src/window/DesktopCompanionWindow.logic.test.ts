import { describe, expect, it } from "vite-plus/test";

import { boundsDiffer, companionBounds, keepInWorkArea } from "./DesktopCompanionWindow.logic.ts";

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
