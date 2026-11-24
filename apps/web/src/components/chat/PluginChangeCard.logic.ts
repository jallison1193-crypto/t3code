import type { InstalledPlugin, PluginWorkerFolderAccess } from "@t3tools/contracts";
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
  | "approve"
  | "undo"
  | "restore";

export type PluginChangeCardLine =
  | { readonly kind: "css" }
  | { readonly kind: "panel" }
  | { readonly kind: "command"; readonly name: string }
  | { readonly kind: "command-generic" }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "skill-generic" }
  | { readonly kind: "instructions" }
  | { readonly kind: "mcp-server"; readonly name: string; readonly target: string }
  | { readonly kind: "mcp-generic" }
  | { readonly kind: "hook"; readonly event: string; readonly target: string }
  | { readonly kind: "hook-generic" }
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "agent-generic" }
  | { readonly kind: "external-outside-sandbox" }
  | { readonly kind: "unsupported"; readonly parts: ReadonlyArray<string> }
  | { readonly kind: "worker-runs" }
  | {
      readonly kind: "worker-folder";
      readonly id: string;
      readonly label: string;
      readonly access: PluginWorkerFolderAccess;
    }
  | { readonly kind: "worker-network" }
  | { readonly kind: "worker-schedule"; readonly everyMinutes: number }
  | { readonly kind: "worker-network-unrestricted" };

export interface PluginChangeCardState {
  readonly status: PluginChangeCardStatus;
  readonly muted: boolean;
  readonly actions: ReadonlyArray<PluginChangeCardAction>;
}

type LivePluginCardSnapshot = Pick<
  InstalledPlugin,
  | "enabled"
  | "revision"
  | "worker"
  | "commands"
  | "skills"
  | "mcpServers"
  | "hooks"
  | "agents"
  | "externalStatus"
  | "unsupported"
>;

export function resolvePluginChangeCardLines(
  change: PluginChange,
  livePlugin?: LivePluginCardSnapshot,
): ReadonlyArray<PluginChangeCardLine> {
  const lines: Array<PluginChangeCardLine> = [];
  let hasExternal = false;
  for (const contribution of change.contributes) {
    if (contribution === "css") {
      lines.push({ kind: "css" });
    } else if (contribution === "panel") {
      lines.push({ kind: "panel" });
    } else if (contribution === "command") {
      const commandNames = change.commands ?? livePlugin?.commands;
      if (commandNames !== undefined && commandNames.length > 0) {
        for (const name of commandNames) {
          lines.push({ kind: "command", name });
        }
      } else {
        lines.push({ kind: "command-generic" });
      }
    } else if (contribution === "skill") {
      const skillNames = change.skills ?? livePlugin?.skills;
      if (skillNames !== undefined && skillNames.length > 0) {
        for (const name of skillNames) {
          lines.push({ kind: "skill", name });
        }
      } else {
        lines.push({ kind: "skill-generic" });
      }
    } else if (contribution === "instructions") {
      lines.push({ kind: "instructions" });
    } else if (contribution === "mcp") {
      hasExternal = true;
      const servers =
        change.mcpServers ?? livePlugin?.mcpServers?.map(({ name, target }) => ({ name, target }));
      if (servers !== undefined && servers.length > 0) {
        for (const server of servers) {
          lines.push({ kind: "mcp-server", name: server.name, target: server.target });
        }
      } else {
        lines.push({ kind: "mcp-generic" });
      }
    } else if (contribution === "hook") {
      hasExternal = true;
      const hooks =
        change.hooks ?? livePlugin?.hooks?.map(({ event, target }) => ({ event, target }));
      if (hooks !== undefined && hooks.length > 0) {
        for (const hook of hooks) {
          lines.push({ kind: "hook", event: hook.event, target: hook.target });
        }
      } else {
        lines.push({ kind: "hook-generic" });
      }
    } else if (contribution === "agent") {
      const agentNames = change.agents ?? livePlugin?.agents?.map((agent) => agent.name);
      if (agentNames !== undefined && agentNames.length > 0) {
        for (const name of agentNames) {
          lines.push({ kind: "agent", name });
        }
      } else {
        lines.push({ kind: "agent-generic" });
      }
    } else if (contribution === "worker") {
      lines.push({ kind: "worker-runs" });
      const worker = change.worker ?? livePlugin?.worker;
      if (worker !== undefined) {
        for (const folder of worker.folders) {
          lines.push({
            kind: "worker-folder",
            id: folder.id,
            label: folder.label,
            access: folder.access,
          });
        }
        if (worker.network) {
          lines.push({ kind: "worker-network" });
        }
        if (worker.everyMinutes !== undefined) {
          lines.push({ kind: "worker-schedule", everyMinutes: worker.everyMinutes });
        }
      }
      if (livePlugin?.worker?.networkRestricted === false) {
        lines.push({ kind: "worker-network-unrestricted" });
      }
    }
  }
  if (hasExternal) {
    lines.push({ kind: "external-outside-sandbox" });
  }
  const unsupported = change.unsupported ?? livePlugin?.unsupported;
  if (unsupported !== undefined && unsupported.length > 0) {
    lines.push({ kind: "unsupported", parts: unsupported });
  }
  return lines;
}

export function resolvePluginChangeCardState(
  change: PluginChange,
  livePlugin: LivePluginCardSnapshot | undefined,
): PluginChangeCardState {
  const needsApproval =
    livePlugin?.worker?.status === "needs-approval" ||
    livePlugin?.externalStatus === "needs-approval";

  if (change.created) {
    if (livePlugin === undefined) {
      return { status: "cancelled", muted: false, actions: ["install-anyway"] };
    }
    if (livePlugin.revision === change.after) {
      return livePlugin.enabled
        ? {
            status: "installed",
            muted: false,
            actions: needsApproval ? ["approve", "turn-off"] : ["turn-off"],
          }
        : { status: "new", muted: false, actions: ["install", "cancel"] };
    }
    return { status: "changed-since", muted: true, actions: [] };
  }

  if (livePlugin !== undefined && livePlugin.revision === change.after) {
    const canUndo = change.before !== undefined && change.before !== change.after;
    return {
      status: "updated",
      muted: false,
      actions: [
        ...(needsApproval ? (["approve"] as const) : []),
        ...(canUndo ? (["undo"] as const) : []),
      ],
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
