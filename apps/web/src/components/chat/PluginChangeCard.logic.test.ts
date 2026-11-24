import type { InstalledPlugin } from "@t3tools/contracts";
import type { PluginChange } from "@t3tools/shared/toolOutput";
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePluginChangeCardLines,
  resolvePluginChangeCardState,
  type PluginChangeCardLine,
  type PluginChangeCardState,
} from "./PluginChangeCard.logic";

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

const WORKER_EDIT_CHANGE: PluginChange = {
  pluginId: "vault-sync",
  created: false,
  before: REV_BEFORE,
  after: REV_AFTER,
  contributes: ["worker"],
  worker: {
    everyMinutes: 15,
    folders: [
      { id: "notes", label: "Reference notes", access: "read" },
      { id: "vault", label: "Obsidian vault", access: "write" },
    ],
    network: true,
  },
};

describe("resolvePluginChangeCardState", () => {
  it.each<{
    readonly name: string;
    readonly change: PluginChange;
    readonly livePlugin: Pick<InstalledPlugin, "enabled" | "revision" | "worker"> | undefined;
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
      name: "edit that widened worker powers, at after -> Updated with Approve and Undo",
      change: WORKER_EDIT_CHANGE,
      livePlugin: {
        enabled: true,
        revision: REV_AFTER,
        worker: {
          everyMinutes: 15,
          folders: [{ id: "vault", label: "Obsidian vault", access: "write", path: null }],
          network: true,
          status: "needs-approval",
          networkRestricted: true,
        },
      },
      expected: { status: "updated", muted: false, actions: ["approve", "undo"] },
    },
    {
      name: "edit after powers approved, at after -> Updated with Undo only",
      change: WORKER_EDIT_CHANGE,
      livePlugin: {
        enabled: true,
        revision: REV_AFTER,
        worker: {
          everyMinutes: 15,
          folders: [{ id: "vault", label: "Obsidian vault", access: "write", path: "/vault" }],
          network: true,
          status: "running",
          networkRestricted: true,
        },
      },
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

describe("resolvePluginChangeCardLines", () => {
  it.each<{
    readonly name: string;
    readonly change: PluginChange;
    readonly livePlugin?: Pick<InstalledPlugin, "enabled" | "revision" | "worker">;
    readonly expected: ReadonlyArray<PluginChangeCardLine>;
  }>([
    {
      name: "lists worker background code, folders, network, schedule, and unrestricted runtime warning",
      change: WORKER_EDIT_CHANGE,
      livePlugin: {
        enabled: false,
        revision: REV_AFTER,
        worker: {
          everyMinutes: 15,
          folders: [],
          network: true,
          status: "stopped",
          networkRestricted: false,
        },
      },
      expected: [
        { kind: "worker-runs" },
        { kind: "worker-folder", id: "notes", label: "Reference notes", access: "read" },
        { kind: "worker-folder", id: "vault", label: "Obsidian vault", access: "write" },
        { kind: "worker-network" },
        { kind: "worker-schedule", everyMinutes: 15 },
        { kind: "worker-network-unrestricted" },
      ],
    },
    {
      name: "omits network and schedule lines when not declared and omits warning when network is restricted",
      change: {
        pluginId: "simple-worker",
        created: true,
        after: REV_AFTER,
        contributes: ["css", "worker"],
        worker: {
          folders: [{ id: "out", label: "Export folder", access: "write" }],
          network: false,
        },
      },
      livePlugin: {
        enabled: false,
        revision: REV_AFTER,
        worker: {
          folders: [{ id: "out", label: "Export folder", access: "write", path: null }],
          network: false,
          status: "stopped",
          networkRestricted: true,
        },
      },
      expected: [
        { kind: "css" },
        { kind: "worker-runs" },
        { kind: "worker-folder", id: "out", label: "Export folder", access: "write" },
      ],
    },
    {
      name: "lists commands, skills, instructions, and unsupported parts in plain lines",
      change: {
        pluginId: "daily",
        created: true,
        after: REV_AFTER,
        contributes: ["command", "skill", "instructions"],
        commands: ["standup"],
        skills: ["review"],
        unsupported: ["hooks", "mcp"],
      },
      expected: [
        { kind: "command", name: "standup" },
        { kind: "skill", name: "review" },
        { kind: "instructions" },
        { kind: "unsupported", parts: ["hooks", "mcp"] },
      ],
    },
  ])("$name", ({ change, livePlugin, expected }) => {
    expect(resolvePluginChangeCardLines(change, livePlugin)).toEqual(expected);
  });
});
