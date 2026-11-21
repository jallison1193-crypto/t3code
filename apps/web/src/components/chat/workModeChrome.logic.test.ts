import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";
import {
  isCodingChromeVisible,
  isHiddenChatShortcutInWorkMode,
  isHiddenRightPanelSurfaceInWorkMode,
  mapVisibleRightPanelMoveIndex,
  resolveWorkModeRightPanelPresentation,
} from "./workModeChrome.logic";

const DIFF: RightPanelSurface = { id: "diff", kind: "diff" };
const TERMINAL: RightPanelSurface = {
  id: "terminal:default",
  kind: "terminal",
  resourceId: "default",
  terminalIds: ["default"],
  activeTerminalId: "default",
};
const FILES: RightPanelSurface = { id: "files", kind: "files" };
const BROWSER: RightPanelSurface = { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" };
const CHILD_THREAD: RightPanelSurface = {
  id: "thread:child-1",
  kind: "thread",
  threadId: ThreadId.make("child-1"),
  variant: "thread",
};
const LINKED_THREAD: RightPanelSurface = {
  id: "linked-thread:env-1:env-2:thread-2",
  kind: "linked-thread",
  viaEnvironmentId: EnvironmentId.make("env-1"),
  environmentId: EnvironmentId.make("env-2"),
  threadId: ThreadId.make("thread-2"),
  label: "Remote",
  title: "Linked thread",
};

describe("workModeChrome.logic", () => {
  it("reports coding chrome visible only in code mode", () => {
    expect(isCodingChromeVisible("code")).toBe(true);
    expect(isCodingChromeVisible("work")).toBe(false);
  });

  it("hides only diff and terminal right-panel surfaces in work mode", () => {
    expect(isHiddenRightPanelSurfaceInWorkMode(DIFF)).toBe(true);
    expect(isHiddenRightPanelSurfaceInWorkMode(TERMINAL)).toBe(true);
    expect(isHiddenRightPanelSurfaceInWorkMode(FILES)).toBe(false);
    expect(isHiddenRightPanelSurfaceInWorkMode(BROWSER)).toBe(false);
    expect(isHiddenRightPanelSurfaceInWorkMode(CHILD_THREAD)).toBe(false);
    expect(isHiddenRightPanelSurfaceInWorkMode(LINKED_THREAD)).toBe(false);
    expect(isHiddenRightPanelSurfaceInWorkMode({ kind: "pull-requests" })).toBe(false);
    expect(isHiddenRightPanelSurfaceInWorkMode({ kind: "issue" })).toBe(false);
    expect(isHiddenRightPanelSurfaceInWorkMode({ kind: "device" })).toBe(false);
  });

  it("blocks coding shortcuts and project scripts in work mode while preserving noncoding shortcuts", () => {
    for (const command of [
      "terminal.toggle",
      "terminal.split",
      "terminal.splitVertical",
      "terminal.new",
      "terminal.close",
      "diff.toggle",
      "composer.workspace",
      "composer.branch",
      "composer.previousWorktree",
      "script.dev.run",
    ] as const) {
      expect(isHiddenChatShortcutInWorkMode(command)).toBe(true);
    }

    for (const command of [
      "rightPanel.toggle",
      "rightPanel.new",
      "rightPanel.close",
      "rightPanel.toggleMaximized",
      "threadPanel.toggle",
      "preview.toggle",
      "composer.host",
      "composer.mode",
      "composer.effort",
      "chat.find",
      "thread.stop",
      "view.reopenClosed",
    ] as const) {
      expect(isHiddenChatShortcutInWorkMode(command)).toBe(false);
    }
  });

  it("hides coding-only right panels in work mode without losing code-mode state, and allows opening the empty launcher", () => {
    const surfaces = [DIFF, TERMINAL];
    const inCode = resolveWorkModeRightPanelPresentation({
      appMode: "code",
      isOpen: true,
      surfaces,
      activeSurfaceId: DIFF.id,
      maximized: true,
      emptyLauncherOpen: false,
    });
    expect(inCode).toEqual({
      open: true,
      surfaces,
      activeSurface: DIFF,
      maximized: true,
      hasOnlyHiddenSurfaces: false,
    });

    const inWorkClosed = resolveWorkModeRightPanelPresentation({
      appMode: "work",
      isOpen: true,
      surfaces,
      activeSurfaceId: DIFF.id,
      maximized: true,
      emptyLauncherOpen: false,
    });
    expect(inWorkClosed).toEqual({
      open: false,
      surfaces: [],
      activeSurface: null,
      maximized: false,
      hasOnlyHiddenSurfaces: true,
    });

    const inWorkLauncher = resolveWorkModeRightPanelPresentation({
      appMode: "work",
      isOpen: true,
      surfaces,
      activeSurfaceId: DIFF.id,
      maximized: true,
      emptyLauncherOpen: true,
    });
    expect(inWorkLauncher).toEqual({
      open: true,
      surfaces: [],
      activeSurface: null,
      maximized: false,
      hasOnlyHiddenSurfaces: true,
    });
  });

  it("falls back to a visible noncoding surface when the stored active tab is hidden in work mode", () => {
    const surfaces = [DIFF, CHILD_THREAD, TERMINAL, FILES];
    const presented = resolveWorkModeRightPanelPresentation({
      appMode: "work",
      isOpen: true,
      surfaces,
      activeSurfaceId: DIFF.id,
      maximized: true,
      emptyLauncherOpen: false,
    });
    expect(presented).toEqual({
      open: true,
      surfaces: [CHILD_THREAD, FILES],
      activeSurface: CHILD_THREAD,
      maximized: true,
      hasOnlyHiddenSurfaces: false,
    });

    const keepingFiles = resolveWorkModeRightPanelPresentation({
      appMode: "work",
      isOpen: true,
      surfaces,
      activeSurfaceId: FILES.id,
      maximized: false,
      emptyLauncherOpen: false,
    });
    expect(keepingFiles.activeSurface).toBe(FILES);
  });

  it("maps visible tab reorder indices back to stored surface indices across hidden tabs", () => {
    const stored = [DIFF, CHILD_THREAD, TERMINAL, FILES, BROWSER];
    const visible = [CHILD_THREAD, FILES, BROWSER];
    expect(mapVisibleRightPanelMoveIndex(stored, visible, 0)).toBe(1);
    expect(mapVisibleRightPanelMoveIndex(stored, visible, 1)).toBe(3);
    expect(mapVisibleRightPanelMoveIndex(stored, visible, 2)).toBe(4);
    expect(mapVisibleRightPanelMoveIndex(stored, visible, 99)).toBe(4);
  });
});
