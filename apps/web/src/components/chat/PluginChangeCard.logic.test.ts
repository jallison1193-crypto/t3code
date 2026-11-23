import type { PluginChange } from "@t3tools/shared/toolOutput";
import { describe, expect, it } from "vite-plus/test";

import { resolvePluginChangeCardState, type PluginChangeCardState } from "./PluginChangeCard.logic";

const REV_BEFORE = "0123456789ab";
const REV_AFTER = "fedcba987654";
const REV_OTHER = "aaaaaaaaaaaa";

const CREATED_CHANGE: PluginChange = {
  pluginId: "compact-sidebar",
  created: true,
  after: REV_AFTER,
  contributes: ["css"],
};

const EDIT_CHANGE: PluginChange = {
  pluginId: "compact-sidebar",
  created: false,
  before: REV_BEFORE,
  after: REV_AFTER,
  contributes: ["css"],
};

describe("resolvePluginChangeCardState", () => {
  it.each<{
    readonly name: string;
    readonly change: PluginChange;
    readonly livePlugin: { readonly enabled: boolean; readonly revision?: string } | undefined;
    readonly expected: PluginChangeCardState;
  }>([
    {
      name: "created, exists at after, off -> New plugin with Install and Cancel",
      change: CREATED_CHANGE,
      livePlugin: { enabled: false, revision: REV_AFTER },
      expected: { status: "new", muted: false, actions: ["install", "cancel"] },
    },
    {
      name: "created, exists at after, on -> Installed with Turn off",
      change: CREATED_CHANGE,
      livePlugin: { enabled: true, revision: REV_AFTER },
      expected: { status: "installed", muted: false, actions: ["turn-off"] },
    },
    {
      name: "created, missing -> Cancelled with Install anyway",
      change: CREATED_CHANGE,
      livePlugin: undefined,
      expected: { status: "cancelled", muted: false, actions: ["install-anyway"] },
    },
    {
      name: "edit, at after -> Updated with Undo",
      change: EDIT_CHANGE,
      livePlugin: { enabled: true, revision: REV_AFTER },
      expected: { status: "updated", muted: false, actions: ["undo"] },
    },
    {
      name: "edit, at before -> Undone with Restore",
      change: EDIT_CHANGE,
      livePlugin: { enabled: true, revision: REV_BEFORE },
      expected: { status: "undone", muted: false, actions: ["restore"] },
    },
    {
      name: "created, edited later -> Changed since (muted) with no action",
      change: CREATED_CHANGE,
      livePlugin: { enabled: true, revision: REV_OTHER },
      expected: { status: "changed-since", muted: true, actions: [] },
    },
    {
      name: "edit, edited later -> Changed since (muted) with no action",
      change: EDIT_CHANGE,
      livePlugin: { enabled: true, revision: REV_OTHER },
      expected: { status: "changed-since", muted: true, actions: [] },
    },
    {
      name: "edit, uninstalled later -> Changed since (muted) with no action",
      change: EDIT_CHANGE,
      livePlugin: undefined,
      expected: { status: "changed-since", muted: true, actions: [] },
    },
  ])("$name", ({ change, livePlugin, expected }) => {
    expect(resolvePluginChangeCardState(change, livePlugin)).toEqual(expected);
  });
});
