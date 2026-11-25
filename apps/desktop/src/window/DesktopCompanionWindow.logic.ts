import {
  CompanionWindowPosition,
  CompanionWindowSize,
  type DesktopCompanionComputerUse,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";
import type { Rectangle } from "electron";

const MARGIN = 16;
// Matches how far Windows can report a window from where it was put.
const MOVE_TOLERANCE = 2;

const SIZES: Record<CompanionWindowSize, { readonly width: number; readonly height: number }> = {
  small: { width: 72, height: 72 },
  medium: { width: 380, height: 540 },
  large: { width: 640, height: 820 },
};

/** Moves and, if it must, shrinks `bounds` so all of it is inside the work area. */
export function keepInWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

/** Where the settings put the window. "right" and "left" dock it down that side. */
export function companionBounds(input: {
  readonly position: CompanionWindowPosition;
  readonly size: CompanionWindowSize;
  readonly workArea: Rectangle;
}): Rectangle {
  const { position, size, workArea } = input;
  const docked = position === "right" || position === "left";
  const maxHeight = Math.max(0, workArea.height - MARGIN * 2);
  const width = Math.min(SIZES[size].width, Math.max(0, workArea.width - MARGIN * 2));
  // The bubble keeps its shape when docked; it sits halfway down the side.
  const height = docked && size !== "small" ? maxHeight : Math.min(SIZES[size].height, maxHeight);
  const onLeft = position === "left" || position === "bottom-left";
  const x = onLeft ? workArea.x + MARGIN : workArea.x + workArea.width - width - MARGIN;
  const y = docked
    ? workArea.y + Math.round((workArea.height - height) / 2)
    : workArea.y + workArea.height - height - MARGIN;
  return { x, y, width, height };
}

export function boundsDiffer(left: Rectangle, right: Rectangle): boolean {
  return (
    Math.abs(left.x - right.x) > MOVE_TOLERANCE ||
    Math.abs(left.y - right.y) > MOVE_TOLERANCE ||
    Math.abs(left.width - right.width) > MOVE_TOLERANCE ||
    Math.abs(left.height - right.height) > MOVE_TOLERANCE
  );
}

/** Whether clicks pass through the window. A manual toggle wins over computer use. */
export function companionClickThrough(input: {
  readonly override: boolean | null;
  readonly enabled: boolean;
  readonly computerUse: DesktopCompanionComputerUse | null;
}): boolean {
  const { override, enabled, computerUse } = input;
  return override ?? (enabled && computerUse !== null && !computerUse.waitingOnUser);
}

/** Where the user last dragged the window, with the settings in force at the time. */
const SavedCompanionBounds = Schema.Struct({
  position: CompanionWindowPosition,
  size: CompanionWindowSize,
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
});
export type SavedCompanionBounds = typeof SavedCompanionBounds.Type;

export const SavedCompanionBoundsJson = fromLenientJson(SavedCompanionBounds);

/** The dragged bounds, unless Position or Size was chosen anew since. */
export function savedBoundsFor(
  saved: SavedCompanionBounds,
  placement: {
    readonly companionWindowPosition: CompanionWindowPosition;
    readonly companionWindowSize: CompanionWindowSize;
  },
): Rectangle | null {
  const { position, size, ...bounds } = saved;
  return position === placement.companionWindowPosition && size === placement.companionWindowSize
    ? bounds
    : null;
}
