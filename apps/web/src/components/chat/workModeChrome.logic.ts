import type { AppMode, KeybindingCommand } from "@t3tools/contracts";

import { projectScriptIdFromCommand } from "~/projectScripts";
import type { RightPanelSurface } from "~/rightPanelStore";

const WORK_MODE_HIDDEN_CHAT_SHORTCUTS: ReadonlySet<KeybindingCommand> = new Set([
  "terminal.toggle",
  "terminal.split",
  "terminal.splitVertical",
  "terminal.new",
  "terminal.close",
  "diff.toggle",
  "composer.workspace",
  "composer.branch",
  "composer.previousWorktree",
]);

export function isCodingChromeVisible(appMode: AppMode): boolean {
  return appMode !== "work";
}

export function isHiddenRightPanelSurfaceInWorkMode(
  surface: Pick<RightPanelSurface, "kind">,
): boolean {
  return surface.kind === "diff" || surface.kind === "terminal";
}

export function isHiddenChatShortcutInWorkMode(command: KeybindingCommand): boolean {
  return (
    WORK_MODE_HIDDEN_CHAT_SHORTCUTS.has(command) || projectScriptIdFromCommand(command) !== null
  );
}

export interface WorkModeRightPanelPresentation {
  readonly open: boolean;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurface: RightPanelSurface | null;
  readonly maximized: boolean;
  readonly hasOnlyHiddenSurfaces: boolean;
}

export function resolveWorkModeRightPanelPresentation(input: {
  readonly appMode: AppMode;
  readonly isOpen: boolean;
  readonly surfaces: readonly RightPanelSurface[];
  readonly activeSurfaceId: string | null;
  readonly maximized: boolean;
  readonly emptyLauncherOpen: boolean;
}): WorkModeRightPanelPresentation {
  if (isCodingChromeVisible(input.appMode)) {
    const activeSurface = input.isOpen
      ? (input.surfaces.find((surface) => surface.id === input.activeSurfaceId) ?? null)
      : null;
    return {
      open: input.isOpen,
      surfaces: input.surfaces,
      activeSurface,
      maximized: input.isOpen && input.maximized,
      hasOnlyHiddenSurfaces: false,
    };
  }

  const surfaces = input.surfaces.filter(
    (surface) => !isHiddenRightPanelSurfaceInWorkMode(surface),
  );
  const hasOnlyHiddenSurfaces = input.surfaces.length > 0 && surfaces.length === 0;
  const open = hasOnlyHiddenSurfaces ? input.emptyLauncherOpen : input.isOpen;
  if (!open) {
    return {
      open: false,
      surfaces,
      activeSurface: null,
      maximized: false,
      hasOnlyHiddenSurfaces,
    };
  }

  const storedActive = input.surfaces.find((surface) => surface.id === input.activeSurfaceId);
  const activeSurface =
    storedActive !== undefined && !isHiddenRightPanelSurfaceInWorkMode(storedActive)
      ? storedActive
      : (surfaces[0] ?? null);

  return {
    open: true,
    surfaces,
    activeSurface,
    maximized: !hasOnlyHiddenSurfaces && input.maximized,
    hasOnlyHiddenSurfaces,
  };
}

export function mapVisibleRightPanelMoveIndex(
  storedSurfaces: readonly RightPanelSurface[],
  visibleSurfaces: readonly RightPanelSurface[],
  toVisibleIndex: number,
): number {
  const targetSurface = visibleSurfaces[toVisibleIndex];
  if (targetSurface === undefined) return storedSurfaces.length - 1;
  const storedIndex = storedSurfaces.findIndex((surface) => surface.id === targetSurface.id);
  return storedIndex >= 0 ? storedIndex : toVisibleIndex;
}
