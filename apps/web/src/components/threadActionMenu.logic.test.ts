import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("shows coordinator actions only when supported and toggles by isCoordinator", () => {
    const unsupported = buildThreadActionMenuItems(baseState);
    expect(
      unsupported.some(
        (item) => item.id === "make-coordinator" || item.id === "remove-coordinator",
      ),
    ).toBe(false);

    const nonCoordinator = buildThreadActionMenuItems({
      ...baseState,
      isCoordinator: false,
      supports: { ...baseState.supports, coordinator: true },
    });
    expect(nonCoordinator.find((item) => item.id === "make-coordinator")?.label).toBe(
      "Make project coordinator",
    );
    expect(nonCoordinator.find((item) => item.id === "remove-coordinator")).toBeUndefined();

    const coordinator = buildThreadActionMenuItems({
      ...baseState,
      isCoordinator: true,
      supports: { ...baseState.supports, coordinator: true },
    });
    expect(coordinator.find((item) => item.id === "remove-coordinator")?.label).toBe(
      "Remove as coordinator",
    );
    expect(coordinator.find((item) => item.id === "make-coordinator")).toBeUndefined();
  });

  it("shows Move to Work or Move to Code based on threadMode and gates on canOperate", () => {
    const omitted = buildThreadActionMenuItems(baseState);
    expect(omitted.some((item) => item.id === "move-to-work" || item.id === "move-to-code")).toBe(
      false,
    );

    const codeThread = buildThreadActionMenuItems({ ...baseState, threadMode: "code" });
    expect(codeThread.find((item) => item.id === "move-to-work")).toEqual({
      id: "move-to-work",
      label: "Move to Work",
    });
    expect(codeThread.find((item) => item.id === "move-to-code")).toBeUndefined();

    const codeReadOnly = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      threadMode: "code",
    });
    expect(codeReadOnly.find((item) => item.id === "move-to-work")).toEqual({
      id: "move-to-work",
      label: "Move to Work",
      disabled: true,
    });

    const workThread = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      threadMode: "work",
    });
    expect(workThread.find((item) => item.id === "move-to-code")).toEqual({
      id: "move-to-code",
      label: "Move to Code",
      disabled: true,
    });
    expect(workThread.find((item) => item.id === "move-to-work")).toBeUndefined();
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});
