import type { EnvironmentId } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { PluginChange } from "@t3tools/shared/toolOutput";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  resolvePluginChangeCardLines,
  resolvePluginChangeCardState,
  type PluginChangeCardAction,
  type PluginChangeCardLine,
  type PluginChangeCardStatus,
} from "./PluginChangeCard.logic";

function StatusLabel({ status }: { readonly status: PluginChangeCardStatus }) {
  switch (status) {
    case "new":
      return <T>New plugin</T>;
    case "installed":
      return <T>Installed</T>;
    case "cancelled":
      return <T>Cancelled</T>;
    case "updated":
      return <T>Updated</T>;
    case "undone":
      return <T>Undone</T>;
    case "changed-since":
      return <T>Changed since</T>;
  }
}

function unsupportedPartLabel(part: string, gt: ReturnType<typeof useGT>): string {
  switch (part) {
    case "hooks":
      return gt("hooks");
    case "mcp":
      return gt("MCP servers");
    case "agents":
      return gt("agents");
    case "css":
      return gt("CSS");
    case "panels":
      return gt("panels");
    case "worker":
      return gt("worker");
    default:
      return part;
  }
}

function CardLine({ line }: { readonly line: PluginChangeCardLine }) {
  const gt = useGT();
  switch (line.kind) {
    case "css":
      return <T>Restyles T3 with CSS</T>;
    case "panel":
      return <T>Adds a right panel tab</T>;
    case "command":
      return (
        <T>
          Adds /<Var>{line.name}</Var>
        </T>
      );
    case "command-generic":
      return <T>Adds slash commands</T>;
    case "skill":
      return (
        <T>
          Adds skill <Var>{line.name}</Var>
        </T>
      );
    case "skill-generic":
      return <T>Adds skills for agents</T>;
    case "instructions":
      return <T>Adds instructions for agents</T>;
    case "mcp-server":
      return (
        <T>
          Runs MCP server <Var>{line.name}</Var>: <Var>{line.target}</Var>
        </T>
      );
    case "mcp-generic":
      return <T>Runs MCP servers</T>;
    case "hook":
      return (
        <T>
          Runs hooks in Claude threads: <Var>{line.event}</Var> <Var>{line.target}</Var>
        </T>
      );
    case "hook-generic":
      return <T>Runs hooks in Claude threads</T>;
    case "agent":
      return (
        <T>
          Adds agent <Var>{line.name}</Var> (Claude threads)
        </T>
      );
    case "agent-generic":
      return <T>Adds agents (Claude threads)</T>;
    case "external-outside-sandbox":
      return <T>MCP servers and hooks run outside the sandbox.</T>;
    case "unsupported":
      return (
        <T>
          Not supported yet:{" "}
          <Var>{line.parts.map((part) => unsupportedPartLabel(part, gt)).join(", ")}</Var>
        </T>
      );
    case "worker-runs":
      return <T>Runs background code on this computer</T>;
    case "worker-folder":
      return line.access === "write" ? (
        <T>
          Reads and writes <Var>{line.label}</Var>
        </T>
      ) : (
        <T>
          Reads <Var>{line.label}</Var>
        </T>
      );
    case "worker-network":
      return <T>Uses the network</T>;
    case "worker-schedule":
      return (
        <T>
          Runs every <Var>{line.everyMinutes}</Var> minutes
        </T>
      );
    case "worker-network-unrestricted":
      return <T>Network access is not blocked on this T3 runtime.</T>;
  }
}

function cardLineKey(line: PluginChangeCardLine, index: number): string {
  switch (line.kind) {
    case "worker-folder":
      return `worker-folder:${line.id}`;
    case "command":
      return `command:${line.name}`;
    case "skill":
      return `skill:${line.name}`;
    case "mcp-server":
      return `mcp-server:${line.name}`;
    case "hook":
      return `hook:${line.event}:${index}`;
    case "agent":
      return `agent:${line.name}`;
    case "unsupported":
      return `unsupported:${line.parts.join(",")}`;
    default:
      return line.kind;
  }
}

export function PluginChangeCard({
  rowId,
  environmentId,
  change,
}: {
  readonly rowId: string;
  readonly environmentId: EnvironmentId;
  readonly change: PluginChange;
}) {
  const headingId = useId();
  const gt = useGT();
  const messages = useMessages();
  const [busy, setBusy] = useState(false);

  const pluginsQuery = useEnvironmentQuery(
    serverEnvironment.pluginsList({ environmentId, input: {} }, rowId),
    messages,
  );
  const canSetEnabled = useAtomValue(
    serverEnvironment.setPluginEnabled.permissionAtom(environmentId),
  );
  const canUninstall = useAtomValue(
    serverEnvironment.uninstallPlugin.permissionAtom(environmentId),
  );
  const canRestore = useAtomValue(
    serverEnvironment.restorePluginRevision.permissionAtom(environmentId),
  );
  const canApproveWorker = useAtomValue(
    serverEnvironment.approvePluginWorker.permissionAtom(environmentId),
  );

  const setPluginEnabled = useAtomCommand(serverEnvironment.setPluginEnabled, {
    label: "plugin enabled update",
    reportFailure: false,
  });
  const uninstallPlugin = useAtomCommand(serverEnvironment.uninstallPlugin, {
    label: "plugin uninstall",
    reportFailure: false,
  });
  const restorePluginRevision = useAtomCommand(serverEnvironment.restorePluginRevision, {
    label: "plugin revision restore",
    reportFailure: false,
  });
  const approvePluginWorker = useAtomCommand(serverEnvironment.approvePluginWorker, {
    label: "plugin worker approval",
    reportFailure: false,
  });

  const livePlugin = pluginsQuery.data?.plugins.find((plugin) => plugin.id === change.pluginId);
  const needsWorkerApproval = livePlugin?.worker?.status === "needs-approval";
  const needsExternalApproval = livePlugin?.externalStatus === "needs-approval";
  const state =
    pluginsQuery.data === null ? null : resolvePluginChangeCardState(change, livePlugin);
  const lines = resolvePluginChangeCardLines(change, livePlugin);
  const title = livePlugin?.displayName ?? change.pluginId;

  const reportError = (
    result: AtomCommandResult<unknown, unknown>,
    titleText: string,
    fallback: string,
  ) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: titleText,
        description:
          (error instanceof Error ? thrownErrorMessage(error, messages) : null) ?? fallback,
      });
    }
  };

  const runAction = async (action: PluginChangeCardAction) => {
    setBusy(true);
    switch (action) {
      case "install": {
        const result = await setPluginEnabled({
          environmentId,
          input: {
            id: change.pluginId,
            enabled: true,
            approveWorker: true,
            approveExternal: true,
            revision: change.after,
          },
        });
        reportError(result, gt("Plugin not updated"), gt("Could not update plugin state."));
        break;
      }
      case "turn-off": {
        const result = await setPluginEnabled({
          environmentId,
          input: { id: change.pluginId, enabled: false },
        });
        reportError(result, gt("Plugin not updated"), gt("Could not update plugin state."));
        break;
      }
      case "cancel": {
        const result = await uninstallPlugin({
          environmentId,
          input: { id: change.pluginId },
        });
        reportError(result, gt("Plugin not uninstalled"), gt("Could not uninstall plugin."));
        break;
      }
      case "install-anyway": {
        const result = await restorePluginRevision({
          environmentId,
          input: {
            id: change.pluginId,
            revision: change.after,
            enable: true,
            approveWorker: true,
            approveExternal: true,
          },
        });
        reportError(result, gt("Plugin not restored"), gt("Could not restore plugin revision."));
        break;
      }
      case "approve": {
        if (needsWorkerApproval) {
          const result = await approvePluginWorker({
            environmentId,
            input: { id: change.pluginId, revision: change.after },
          });
          reportError(result, gt("Worker not approved"), gt("Could not approve plugin worker."));
        }
        if (needsExternalApproval) {
          const result = await setPluginEnabled({
            environmentId,
            input: {
              id: change.pluginId,
              enabled: true,
              approveExternal: true,
              revision: change.after,
            },
          });
          reportError(
            result,
            gt("Plugin not approved"),
            gt("Could not approve plugin MCP servers and hooks."),
          );
        }
        break;
      }
      case "undo": {
        if (change.before === undefined) break;
        const result = await restorePluginRevision({
          environmentId,
          input: { id: change.pluginId, revision: change.before },
        });
        reportError(result, gt("Plugin not restored"), gt("Could not restore plugin revision."));
        break;
      }
      case "restore": {
        const result = await restorePluginRevision({
          environmentId,
          input: { id: change.pluginId, revision: change.after },
        });
        reportError(result, gt("Plugin not restored"), gt("Could not restore plugin revision."));
        break;
      }
    }
    setBusy(false);
  };

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border/80 bg-card/70">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h3 id={headingId} className="min-w-0 truncate text-sm font-medium text-foreground">
          {title}
        </h3>
        {state !== null ? (
          state.muted ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              <StatusLabel status={state.status} />
            </span>
          ) : (
            <Badge size="sm" variant="outline">
              <StatusLabel status={state.status} />
            </Badge>
          )
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <ul className="min-w-0 flex-1 space-y-0.5 text-xs text-muted-foreground">
          {lines.map((line, index) => (
            <li key={cardLineKey(line, index)}>
              <CardLine line={line} />
            </li>
          ))}
        </ul>
        {state !== null && state.actions.length > 0 ? (
          <div className="flex shrink-0 items-center gap-2">
            {state.actions.map((action) => {
              switch (action) {
                case "install":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="default"
                      disabled={busy || !canSetEnabled}
                      onClick={() => void runAction(action)}
                    >
                      <T>Install</T>
                    </Button>
                  );
                case "cancel":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="ghost"
                      disabled={busy || !canUninstall}
                      onClick={() => void runAction(action)}
                    >
                      <T>Cancel</T>
                    </Button>
                  );
                case "turn-off":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="outline"
                      disabled={busy || !canSetEnabled}
                      onClick={() => void runAction(action)}
                    >
                      <T>Turn off</T>
                    </Button>
                  );
                case "install-anyway":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="outline"
                      disabled={busy || !canRestore}
                      onClick={() => void runAction(action)}
                    >
                      <T>Install anyway</T>
                    </Button>
                  );
                case "approve":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="default"
                      disabled={
                        busy ||
                        (needsWorkerApproval && !canApproveWorker) ||
                        (needsExternalApproval && !canSetEnabled)
                      }
                      onClick={() => void runAction(action)}
                    >
                      <T>Approve</T>
                    </Button>
                  );
                case "undo":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="outline"
                      disabled={busy || !canRestore}
                      onClick={() => void runAction(action)}
                    >
                      <T>Undo</T>
                    </Button>
                  );
                case "restore":
                  return (
                    <Button
                      key={action}
                      size="xs"
                      variant="outline"
                      disabled={busy || !canRestore}
                      onClick={() => void runAction(action)}
                    >
                      <T>Restore</T>
                    </Button>
                  );
              }
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
