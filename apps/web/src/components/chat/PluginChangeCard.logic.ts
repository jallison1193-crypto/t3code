import type { InstalledPlugin } from "@t3tools/contracts";
import type { PluginChange } from "@t3tools/shared/toolOutput";

export type PluginChangeCardStatus =
  | "new"
  | "installed"
  | "cancelled"
  | "updated"
  | "undone"
  | "changed-since";

export type PluginChangeCardAction =
  | "install"
  | "cancel"
  | "turn-off"
  | "install-anyway"
  | "undo"
  | "restore";

export interface PluginChangeCardState {
  readonly status: PluginChangeCardStatus;
  readonly muted: boolean;
  readonly actions: ReadonlyArray<PluginChangeCardAction>;
}

export function resolvePluginChangeCardState(
  change: PluginChange,
  livePlugin: Pick<InstalledPlugin, "enabled" | "revision"> | undefined,
): PluginChangeCardState {
  if (change.created) {
    if (livePlugin === undefined) {
      return { status: "cancelled", muted: false, actions: ["install-anyway"] };
    }
    if (livePlugin.revision === change.after) {
      return livePlugin.enabled
        ? { status: "installed", muted: false, actions: ["turn-off"] }
        : { status: "new", muted: false, actions: ["install", "cancel"] };
    }
    return { status: "changed-since", muted: true, actions: [] };
  }

  if (livePlugin !== undefined && livePlugin.revision === change.after) {
    return {
      status: "updated",
      muted: false,
      actions: change.before !== undefined && change.before !== change.after ? ["undo"] : [],
    };
  }

  if (
    livePlugin !== undefined &&
    change.before !== undefined &&
    livePlugin.revision === change.before
  ) {
    return { status: "undone", muted: false, actions: ["restore"] };
  }

  return { status: "changed-since", muted: true, actions: [] };
}
