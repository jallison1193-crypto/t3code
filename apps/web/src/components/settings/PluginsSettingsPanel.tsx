import type {
  EnvironmentId,
  InstalledPlugin,
  InstalledPluginMcpServer,
  InstalledPluginWorker,
  PluginId,
  PluginMcpServerStatus,
  PluginWorkerStatus,
  ProjectId,
  RepoPluginStatus,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const REPO_DISALLOWED_PARTS = new Set(["css", "panels", "worker", "mcp", "hooks"]);

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

function PluginTextPartsDetails({
  plugin,
  isRepo,
}: {
  readonly plugin: InstalledPlugin;
  readonly isRepo: boolean;
}) {
  const gt = useGT();
  const hasCommands = plugin.commands !== undefined && plugin.commands.length > 0;
  const hasSkills = plugin.skills !== undefined && plugin.skills.length > 0;
  const hasAgents = plugin.agents !== undefined && plugin.agents.length > 0;
  const hasInstructions = plugin.contributes.includes("instructions");
  const partProblems = plugin.partProblems ?? [];
  const unsupported = plugin.unsupported ?? [];
  const repoDisallowed = isRepo
    ? unsupported.filter((part) => REPO_DISALLOWED_PARTS.has(part))
    : [];
  const notYetSupported = isRepo
    ? unsupported.filter((part) => !REPO_DISALLOWED_PARTS.has(part))
    : unsupported;

  if (
    !hasCommands &&
    !hasSkills &&
    !hasAgents &&
    !hasInstructions &&
    partProblems.length === 0 &&
    repoDisallowed.length === 0 &&
    notYetSupported.length === 0
  ) {
    return null;
  }

  return (
    <div className="mt-1.5 space-y-1 pb-1.5 text-xs text-muted-foreground">
      {hasCommands ? (
        <p>
          <T>
            Commands:{" "}
            <span className="font-mono text-foreground">
              <Var>{plugin.commands!.map((name) => `/${name}`).join(", ")}</Var>
            </span>
          </T>
        </p>
      ) : null}
      {hasSkills ? (
        <p>
          <T>
            Skills:{" "}
            <span className="font-mono text-foreground">
              <Var>{plugin.skills!.join(", ")}</Var>
            </span>
          </T>
        </p>
      ) : null}
      {hasAgents ? (
        <p>
          <T>
            Agents (Claude threads only):{" "}
            <span className="font-mono text-foreground">
              <Var>{plugin.agents!.map((agent) => agent.name).join(", ")}</Var>
            </span>
          </T>
        </p>
      ) : null}
      {hasInstructions ? (
        <p>
          <T>Adds instructions for agents</T>
        </p>
      ) : null}
      {partProblems.map((problem) => (
        <p key={problem} className="text-warning-foreground">
          {problem}
        </p>
      ))}
      {repoDisallowed.length > 0 ? (
        <p>
          <T>
            Not supported in repo plugins:{" "}
            <Var>{repoDisallowed.map((part) => unsupportedPartLabel(part, gt)).join(", ")}</Var>
          </T>
        </p>
      ) : null}
      {notYetSupported.length > 0 ? (
        <p>
          <T>
            Not supported yet:{" "}
            <Var>{notYetSupported.map((part) => unsupportedPartLabel(part, gt)).join(", ")}</Var>
          </T>
        </p>
      ) : null}
    </div>
  );
}

function McpServerStatusBadge({
  status,
  toolCount,
}: {
  readonly status: PluginMcpServerStatus;
  readonly toolCount: number | undefined;
}) {
  const gt = useGT();
  switch (status) {
    case "running":
      return (
        <Badge size="sm" variant="success">
          {gt("{count, plural, one {Running ({count} tool)} other {Running ({count} tools)}}", {
            count: toolCount ?? 0,
          })}
        </Badge>
      );
    case "starting":
      return (
        <Badge size="sm" variant="outline">
          <T>Starting</T>
        </Badge>
      );
    case "needs-approval":
      return (
        <Badge size="sm" variant="warning">
          <T>Needs approval</T>
        </Badge>
      );
    case "failed":
      return (
        <Badge size="sm" variant="error">
          <T>Failed</T>
        </Badge>
      );
    case "not-runnable":
      return (
        <Badge size="sm" variant="outline">
          <T>Not runnable</T>
        </Badge>
      );
    case "stopped":
      return (
        <Badge size="sm" variant="outline">
          <T>Stopped</T>
        </Badge>
      );
  }
}

function WorkerStatusBadge({ status }: { readonly status: PluginWorkerStatus }) {
  switch (status) {
    case "running":
      return (
        <Badge size="sm" variant="success">
          <T>Running</T>
        </Badge>
      );
    case "needs-approval":
      return (
        <Badge size="sm" variant="warning">
          <T>Needs approval</T>
        </Badge>
      );
    case "needs-folder":
      return (
        <Badge size="sm" variant="warning">
          <T>Needs folder</T>
        </Badge>
      );
    case "crashed":
      return (
        <Badge size="sm" variant="error">
          <T>Crashed</T>
        </Badge>
      );
    case "stopped":
      return (
        <Badge size="sm" variant="outline">
          <T>Stopped</T>
        </Badge>
      );
  }
}

export function PluginsSettingsPanel() {
  const setting = useSearchableSetting();
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";

  return (
    <SettingsPageContainer>
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.environment.capabilities.environmentPlugins !== true ? (
        <SettingsSection {...setting("plugins")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>
              Update T3 Code on <Var>{environment.label}</Var> to manage its plugins.
            </T>
          </p>
        </SettingsSection>
      ) : connected ? (
        <EnvironmentPluginsSection key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...setting("plugins")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment to manage its plugins.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentPluginsSection({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const messages = useMessages();
  const environmentId = environment.environmentId;

  const pluginsQuery = useEnvironmentQuery(
    serverEnvironment.pluginsList({ environmentId, input: {} }),
    messages,
  );
  const pluginsEnabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.pluginsEnabled !== false,
  );
  const livePluginSettings = useEnvironmentSettings(environmentId, (settings) => settings.plugins);
  const liveRepoPluginSettings = useEnvironmentSettings(
    environmentId,
    (settings) => settings.repoPlugins,
  );
  const allProjects = useProjects();
  const projectTitles = new Map<ProjectId, string>();
  for (const project of allProjects) {
    if (project.environmentId === environmentId) {
      projectTitles.set(project.id, project.title);
    }
  }
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const canSetEnabled = useAtomValue(
    serverEnvironment.setPluginEnabled.permissionAtom(environmentId),
  );
  const canUninstall = useAtomValue(
    serverEnvironment.uninstallPlugin.permissionAtom(environmentId),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "plugins enabled update",
    reportFailure: false,
  });
  const setPluginEnabled = useAtomCommand(serverEnvironment.setPluginEnabled, {
    label: "plugin enabled update",
    reportFailure: false,
  });
  const uninstallPlugin = useAtomCommand(serverEnvironment.uninstallPlugin, {
    label: "plugin uninstall",
    reportFailure: false,
  });

  const [savingPluginsEnabled, setSavingPluginsEnabled] = useState(false);
  const [busyPluginKey, setBusyPluginKey] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPlugin | null>(null);

  const plugins = pluginsQuery.data?.plugins ?? [];
  const repoPlugins = pluginsQuery.data?.repoPlugins ?? [];
  const pluginsDir = pluginsQuery.data?.pluginsDir ?? null;

  const repoGroups = (() => {
    const byProject = new Map<ProjectId, Array<InstalledPlugin>>();
    for (const plugin of repoPlugins) {
      if (plugin.projectId === undefined) continue;
      const list = byProject.get(plugin.projectId) ?? [];
      list.push(plugin);
      byProject.set(plugin.projectId, list);
    }
    return [...byProject.entries()]
      .map(([projectId, entries]) => ({
        projectId,
        title: projectTitles.get(projectId) ?? projectId,
        plugins: entries,
      }))
      .sort((left, right) => left.title.localeCompare(right.title));
  })();

  const handleTogglePluginsEnabled = async (next: boolean) => {
    if (savingPluginsEnabled || !canUpdateSettings) return;
    setSavingPluginsEnabled(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { pluginsEnabled: next } },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Plugins setting not updated"),
          description:
            (error instanceof Error ? thrownErrorMessage(error, messages) : null) ??
            gt("Could not update plugins setting."),
        });
      }
    } finally {
      setSavingPluginsEnabled(false);
    }
  };

  const handleToggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    const key = `user:${plugin.id}`;
    setBusyPluginKey(key);
    try {
      const result = await setPluginEnabled({
        environmentId,
        input: { id: plugin.id, enabled },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Plugin not updated"),
          description:
            (error instanceof Error ? thrownErrorMessage(error, messages) : null) ??
            gt("Could not update plugin state."),
        });
      }
    } finally {
      setBusyPluginKey((current) => (current === key ? null : current));
    }
  };

  const handleToggleRepo = async (plugin: InstalledPlugin, enabled: boolean) => {
    if (plugin.projectId === undefined) return;
    const key = `repo:${plugin.projectId}:${plugin.id}`;
    setBusyPluginKey(key);
    try {
      const result = await setPluginEnabled({
        environmentId,
        input: {
          id: plugin.id,
          projectId: plugin.projectId,
          enabled,
          ...(enabled && plugin.revision !== undefined ? { revision: plugin.revision } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        pluginsQuery.refresh();
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Plugin not updated"),
          description:
            (error instanceof Error ? thrownErrorMessage(error, messages) : null) ??
            gt("Could not update plugin state."),
        });
      }
    } finally {
      setBusyPluginKey((current) => (current === key ? null : current));
    }
  };

  const handleConfirmUninstall = async (plugin: InstalledPlugin) => {
    const key = `user:${plugin.id}`;
    setUninstallTarget(null);
    setBusyPluginKey(key);
    try {
      const result = await uninstallPlugin({
        environmentId,
        input: { id: plugin.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Plugin not uninstalled"),
          description:
            (error instanceof Error ? thrownErrorMessage(error, messages) : null) ??
            gt("Could not uninstall plugin."),
        });
      }
    } finally {
      setBusyPluginKey((current) => (current === key ? null : current));
    }
  };

  const uninstallLabel = uninstallTarget?.displayName ?? uninstallTarget?.id ?? "";

  return (
    <>
      <SettingsSection
        {...setting("plugins")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={pluginsQuery.isPending}
            onClick={() => pluginsQuery.refresh()}
          >
            <RefreshCwIcon className="size-3" aria-hidden />
            <T>Refresh</T>
          </Button>
        }
      >
        <SettingsRow
          {...setting("run-plugins")}
          description={
            <T>
              Run installed user and repo plugins on the environment picked above; each environment
              has its own. Turning this off pauses every plugin without uninstalling them.
            </T>
          }
          status={
            !pluginsEnabled ? (
              <T>
                Plugins are switched off. Installed plugins stay installed but do nothing until you
                turn this back on.
              </T>
            ) : undefined
          }
          control={
            <Switch
              checked={pluginsEnabled}
              disabled={!canUpdateSettings || savingPluginsEnabled}
              onCheckedChange={(checked) => void handleTogglePluginsEnabled(Boolean(checked))}
              aria-label={gt("Run plugins")}
            />
          }
        />
        {pluginsQuery.error !== null && pluginsQuery.data === null ? (
          <SettingsRow
            title={gt("Could not load plugins")}
            description={pluginsQuery.error}
            control={
              <Button size="xs" variant="outline" onClick={() => pluginsQuery.refresh()}>
                <T>Retry</T>
              </Button>
            }
          />
        ) : pluginsQuery.data === null && pluginsQuery.isPending ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Loading plugins…</T>
          </p>
        ) : plugins.length === 0 ? (
          <div className="space-y-1.5 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              <T>
                No plugins yet. Ask any agent to make one: describe what you want, and it builds the
                plugin in your plugins folder.
              </T>
            </p>
            {pluginsDir ? (
              <p className="font-mono text-xs text-muted-foreground break-all select-text">
                {pluginsDir}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {plugins.map((plugin) => {
              const label = plugin.displayName ?? plugin.id;
              const hasProblem = plugin.problem !== undefined;
              const storedSetting = Object.hasOwn(livePluginSettings, plugin.id)
                ? livePluginSettings[plugin.id]
                : undefined;
              const enabled =
                !hasProblem &&
                (storedSetting !== undefined ? storedSetting.enabled === true : plugin.enabled);
              const hasExternalApproval = storedSetting?.externalApproval !== undefined;
              const hasExternalParts =
                (plugin.mcpServers !== undefined && plugin.mcpServers.length > 0) ||
                (plugin.hooks !== undefined && plugin.hooks.length > 0);
              const busy = busyPluginKey === `user:${plugin.id}`;
              return (
                <SettingsRow
                  key={plugin.id}
                  className={pluginsEnabled ? undefined : "opacity-55"}
                  title={
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 wrap-anywhere">{label}</span>
                      {plugin.version ? (
                        <span className="text-xs font-normal text-muted-foreground">
                          {plugin.version}
                        </span>
                      ) : null}
                      {plugin.worker !== undefined ? (
                        <WorkerStatusBadge status={plugin.worker.status} />
                      ) : null}
                      {plugin.externalStatus === "needs-approval" &&
                      plugin.worker?.status !== "needs-approval" ? (
                        <Badge size="sm" variant="warning">
                          <T>Needs approval</T>
                        </Badge>
                      ) : null}
                    </span>
                  }
                  description={plugin.description}
                  status={
                    hasProblem ? (
                      <span className="text-muted-foreground">{plugin.problem}</span>
                    ) : plugin.worker?.lastError !== undefined ? (
                      <span className="text-destructive-foreground">{plugin.worker.lastError}</span>
                    ) : undefined
                  }
                  control={
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={enabled}
                        disabled={!canSetEnabled || hasProblem || busy}
                        onCheckedChange={(checked) => void handleToggle(plugin, Boolean(checked))}
                        aria-label={gt("Enable {name}", { name: label })}
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canUninstall || busy}
                        onClick={() => setUninstallTarget(plugin)}
                      >
                        <T>Uninstall</T>
                      </Button>
                    </div>
                  }
                >
                  <PluginTextPartsDetails plugin={plugin} isRepo={false} />
                  {hasExternalParts || hasExternalApproval ? (
                    <PluginExternalDetails
                      environmentId={environmentId}
                      plugin={plugin}
                      hasExternalApproval={hasExternalApproval}
                      hasProblem={hasProblem}
                      rowBusy={busy}
                    />
                  ) : null}
                  {plugin.worker !== undefined ? (
                    <PluginWorkerDetails
                      environmentId={environmentId}
                      pluginId={plugin.id}
                      revision={plugin.revision}
                      worker={plugin.worker}
                      hasProblem={hasProblem}
                      rowBusy={busy}
                    />
                  ) : null}
                </SettingsRow>
              );
            })}
            {pluginsDir ? (
              <div className="px-4 py-2.5 text-xs text-muted-foreground">
                <T>
                  Plugins folder:{" "}
                  <span className="font-mono break-all select-text">
                    <Var>{pluginsDir}</Var>
                  </span>
                </T>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      {repoGroups.length > 0 ? (
        <SettingsSection id="repo-plugins" title={gt("Repo plugins")}>
          {repoGroups.map((group) => (
            <div key={group.projectId} className={pluginsEnabled ? undefined : "opacity-55"}>
              <div className="border-b border-border/60 bg-muted/20 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                {group.title}
              </div>
              {group.plugins.map((plugin) => {
                const label = plugin.displayName ?? plugin.id;
                const hasProblem = plugin.problem !== undefined;
                const projectApprovals = Object.hasOwn(liveRepoPluginSettings, group.projectId)
                  ? liveRepoPluginSettings[group.projectId]
                  : undefined;
                const approvedHash =
                  projectApprovals !== undefined && Object.hasOwn(projectApprovals, plugin.id)
                    ? projectApprovals[plugin.id]
                    : undefined;
                let repoStatus: RepoPluginStatus;
                if (approvedHash === undefined) {
                  repoStatus = "off";
                } else if (!hasProblem && approvedHash === plugin.revision) {
                  repoStatus = "on";
                } else {
                  repoStatus = "changed";
                }
                const enabled = !hasProblem && repoStatus === "on";
                const busy = busyPluginKey === `repo:${group.projectId}:${plugin.id}`;
                return (
                  <SettingsRow
                    key={`${group.projectId}:${plugin.id}`}
                    title={
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="min-w-0 wrap-anywhere">{label}</span>
                        {plugin.version ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            {plugin.version}
                          </span>
                        ) : null}
                        {repoStatus === "changed" ? (
                          <Badge size="sm" variant="warning">
                            <T>Changed</T>
                          </Badge>
                        ) : null}
                      </span>
                    }
                    description={plugin.description}
                    status={
                      hasProblem ? (
                        <span className="text-muted-foreground">{plugin.problem}</span>
                      ) : repoStatus === "changed" ? (
                        <span className="text-warning-foreground">
                          <T>Changed since you turned it on</T>
                        </span>
                      ) : undefined
                    }
                    control={
                      <div className="flex items-center gap-2">
                        {repoStatus === "changed" && !hasProblem ? (
                          <>
                            <Button
                              size="xs"
                              variant="default"
                              disabled={!canSetEnabled || busy || plugin.revision === undefined}
                              onClick={() => void handleToggleRepo(plugin, true)}
                            >
                              <T>Turn on again</T>
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={!canSetEnabled || busy}
                              onClick={() => void handleToggleRepo(plugin, false)}
                            >
                              <T>Turn off</T>
                            </Button>
                          </>
                        ) : (
                          <Switch
                            checked={enabled}
                            disabled={
                              !canSetEnabled ||
                              hasProblem ||
                              busy ||
                              (!enabled && plugin.revision === undefined)
                            }
                            onCheckedChange={(checked) =>
                              void handleToggleRepo(plugin, Boolean(checked))
                            }
                            aria-label={gt("Enable {name}", { name: label })}
                          />
                        )}
                      </div>
                    }
                  >
                    <PluginTextPartsDetails plugin={plugin} isRepo />
                  </SettingsRow>
                );
              })}
            </div>
          ))}
        </SettingsSection>
      ) : null}

      <AlertDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Uninstall <Var>{uninstallLabel}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The plugin folder will be moved to{" "}
                <span className="font-mono text-xs">plugins-archive</span> and its enabled setting
                will be removed. You can restore it later by moving the folder back.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (uninstallTarget) void handleConfirmUninstall(uninstallTarget);
              }}
            >
              <T>Uninstall</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function PluginWorkerDetails({
  environmentId,
  pluginId,
  revision,
  worker,
  hasProblem,
  rowBusy,
}: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly revision: string | undefined;
  readonly worker: InstalledPluginWorker;
  readonly hasProblem: boolean;
  readonly rowBusy: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [savingFolderId, setSavingFolderId] = useState<string | null>(null);
  const [workerActionBusy, setWorkerActionBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logState, setLogState] = useState<{
    readonly log: string;
    readonly truncated: boolean;
  } | null>(null);

  const canApprove = useAtomValue(
    serverEnvironment.approvePluginWorker.permissionAtom(environmentId),
  );
  const canSetFolder = useAtomValue(
    serverEnvironment.setPluginWorkerFolder.permissionAtom(environmentId),
  );
  const canRun = useAtomValue(serverEnvironment.runPluginWorker.permissionAtom(environmentId));

  const approveWorker = useAtomCommand(serverEnvironment.approvePluginWorker, {
    label: "plugin worker approval",
    reportFailure: false,
  });
  const setWorkerFolder = useAtomCommand(serverEnvironment.setPluginWorkerFolder, {
    label: "plugin worker folder update",
    reportFailure: false,
  });
  const runWorker = useAtomCommand(serverEnvironment.runPluginWorker, {
    label: "plugin worker run",
    reportFailure: false,
  });
  const getWorkerLog = useAtomCommand(serverEnvironment.getPluginWorkerLog, {
    label: "plugin worker log read",
    reportFailure: false,
  });

  const reportError = (
    result: AtomCommandResult<unknown, unknown>,
    title: string,
    fallback: string,
  ) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title,
        description:
          (error instanceof Error ? thrownErrorMessage(error, messages) : null) ?? fallback,
      });
    }
  };

  const loadLog = async () => {
    setLogLoading(true);
    try {
      const result = await getWorkerLog({
        environmentId,
        input: { id: pluginId },
      });
      if (result._tag === "Success") {
        setLogState(result.value);
      } else {
        reportError(result, gt("Could not load worker log"), gt("Could not read worker output."));
      }
    } finally {
      setLogLoading(false);
    }
  };

  const handleApprove = async () => {
    setWorkerActionBusy(true);
    try {
      const result = await approveWorker({
        environmentId,
        input: { id: pluginId, ...(revision !== undefined ? { revision } : {}) },
      });
      reportError(result, gt("Worker not approved"), gt("Could not approve plugin worker."));
    } finally {
      setWorkerActionBusy(false);
    }
  };

  const handleRunNow = async () => {
    setWorkerActionBusy(true);
    try {
      const result = await runWorker({
        environmentId,
        input: { id: pluginId },
      });
      if (result._tag === "Success") {
        if (result.value.skipped) {
          toastManager.add({
            type: "info",
            title: gt("Worker already running"),
            description: gt("Wait for the current run to finish before starting another."),
          });
        }
        if (logOpen) {
          void loadLog();
        }
      } else {
        reportError(result, gt("Worker run failed"), gt("Could not run plugin worker."));
      }
    } finally {
      setWorkerActionBusy(false);
    }
  };

  const handleSaveFolder = async (folderId: PluginId, savedPath: string | null) => {
    const rawDraft = Object.hasOwn(drafts, folderId) ? drafts[folderId]! : (savedPath ?? "");
    const trimmed = rawDraft.trim();
    setSavingFolderId(folderId);
    try {
      const result = await setWorkerFolder({
        environmentId,
        input: { id: pluginId, folderId, path: trimmed.length === 0 ? null : trimmed },
      });
      if (result._tag === "Success") {
        setDrafts((current) => {
          const next = { ...current };
          delete next[folderId];
          return next;
        });
      } else {
        reportError(result, gt("Folder not saved"), gt("Could not save worker folder path."));
      }
    } finally {
      setSavingFolderId((current) => (current === folderId ? null : current));
    }
  };

  const busy = rowBusy || workerActionBusy;

  return (
    <div className="mt-2.5 space-y-2.5 border-t border-border/60 pt-2.5 pb-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {worker.everyMinutes !== undefined ? (
            <span>
              <T>
                Runs every <Var>{worker.everyMinutes}</Var> minutes
              </T>
            </span>
          ) : null}
          {worker.network ? (
            <span>
              <T>Uses the network</T>
            </span>
          ) : null}
          {worker.lastRunAt !== undefined ? (
            <span>
              <T>
                Last run: <Var>{new Date(worker.lastRunAt).toLocaleString()}</Var>
              </T>
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {worker.status === "needs-approval" && !hasProblem ? (
            <Button
              size="xs"
              variant="default"
              disabled={!canApprove || busy}
              onClick={() => void handleApprove()}
            >
              <T>Approve</T>
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={!canRun || busy || hasProblem || worker.status !== "running"}
            onClick={() => void handleRunNow()}
          >
            <PlayIcon className="size-3" aria-hidden />
            <T>Run now</T>
          </Button>
        </div>
      </div>

      {!worker.networkRestricted ? (
        <p className="text-muted-foreground">
          <T>Network access is not blocked on this T3 runtime.</T>
        </p>
      ) : null}

      {worker.folders.length > 0 ? (
        <div className="space-y-2">
          {worker.folders.map((folder) => {
            const value = Object.hasOwn(drafts, folder.id)
              ? drafts[folder.id]!
              : (folder.path ?? "");
            const folderSaving = savingFolderId === folder.id;
            const changed = value.trim() !== (folder.path ?? "");
            return (
              <div key={folder.id} className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{folder.label}</span>
                  <span className="text-muted-foreground">
                    {folder.access === "write" ? <T>Reads and writes</T> : <T>Reads</T>}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      size="compact"
                      font="mono"
                      value={value}
                      disabled={!canSetFolder || folderSaving || hasProblem}
                      placeholder={gt("Server folder path")}
                      spellCheck={false}
                      aria-label={folder.label}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [folder.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && changed && canSetFolder && !folderSaving) {
                          event.preventDefault();
                          void handleSaveFolder(folder.id, folder.path);
                        }
                      }}
                    />
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canSetFolder || folderSaving || hasProblem || !changed}
                    onClick={() => void handleSaveFolder(folder.id, folder.path)}
                  >
                    <T>Save</T>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <Collapsible
        open={logOpen}
        onOpenChange={(open) => {
          setLogOpen(open);
          if (open) {
            void loadLog();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRightIcon
              className={`size-3.5 transition-transform ${logOpen ? "rotate-90" : ""}`}
              aria-hidden
            />
            <T>Log</T>
          </CollapsibleTrigger>
          {logOpen ? (
            <Button size="xs" variant="ghost" disabled={logLoading} onClick={() => void loadLog()}>
              <RefreshCwIcon className="size-3" aria-hidden />
              <T>Refresh</T>
            </Button>
          ) : null}
        </div>
        <CollapsiblePanel>
          <div className="mt-1.5 space-y-1">
            <pre className="max-h-60 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2.5 font-mono text-xs text-foreground whitespace-pre-wrap break-all select-text">
              {logLoading && logState === null ? (
                <T>Loading log…</T>
              ) : logState === null || logState.log.length === 0 ? (
                <T>No output yet.</T>
              ) : (
                logState.log
              )}
            </pre>
            {logState?.truncated ? (
              <p className="text-muted-foreground">
                <T>Showing the last 32 KB of worker output.</T>
              </p>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <p className="text-muted-foreground">
        <T>
          Plugin code runs with the folder and network limits above. Only turn on plugins you trust.
        </T>
      </p>
    </div>
  );
}

function PluginExternalDetails({
  environmentId,
  plugin,
  hasExternalApproval,
  hasProblem,
  rowBusy,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: InstalledPlugin;
  readonly hasExternalApproval: boolean;
  readonly hasProblem: boolean;
  readonly rowBusy: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [actionBusy, setActionBusy] = useState(false);

  const canSetEnabled = useAtomValue(
    serverEnvironment.setPluginEnabled.permissionAtom(environmentId),
  );
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const setPluginEnabled = useAtomCommand(serverEnvironment.setPluginEnabled, {
    label: "plugin external approval",
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "plugin external approval removal",
    reportFailure: false,
  });

  const reportError = (
    result: AtomCommandResult<unknown, unknown>,
    title: string,
    fallback: string,
  ) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title,
        description:
          (error instanceof Error ? thrownErrorMessage(error, messages) : null) ?? fallback,
      });
    }
  };

  const handleApprove = async () => {
    setActionBusy(true);
    try {
      const result = await setPluginEnabled({
        environmentId,
        input: {
          id: plugin.id,
          enabled: true,
          approveExternal: true,
          ...(plugin.revision !== undefined ? { revision: plugin.revision } : {}),
        },
      });
      reportError(
        result,
        gt("Plugin not approved"),
        gt("Could not approve plugin MCP servers and hooks."),
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleRemoveApproval = async () => {
    setActionBusy(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            plugins: {
              [plugin.id]: { externalApproval: null },
            },
          },
        },
      });
      reportError(
        result,
        gt("Approval not removed"),
        gt("Could not remove plugin external approval."),
      );
    } finally {
      setActionBusy(false);
    }
  };

  const busy = rowBusy || actionBusy;
  const mcpServers: ReadonlyArray<InstalledPluginMcpServer> = plugin.mcpServers ?? [];
  const hookRows = (() => {
    const seen = new Map<string, number>();
    return (plugin.hooks ?? []).map((hook) => {
      const base = `${hook.event}:${hook.matcher ?? ""}:${hook.type}:${hook.target}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { key: count === 0 ? base : `${base}#${count}`, hook };
    });
  })();

  return (
    <div className="mt-2.5 space-y-2 border-t border-border/60 pt-2.5 pb-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          <T>MCP servers and hooks</T>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {plugin.externalStatus === "needs-approval" && !hasProblem ? (
            <Button
              size="xs"
              variant="default"
              disabled={!canSetEnabled || busy}
              onClick={() => void handleApprove()}
            >
              <T>Approve</T>
            </Button>
          ) : null}
          {hasExternalApproval ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canUpdateSettings || busy}
              onClick={() => void handleRemoveApproval()}
            >
              <T>Remove approval</T>
            </Button>
          ) : null}
        </div>
      </div>

      {mcpServers.length > 0 ? (
        <div className="space-y-1.5">
          {mcpServers.map((server) => (
            <div key={server.name} className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium text-foreground">{server.name}</span>
                <McpServerStatusBadge status={server.status} toolCount={server.toolCount} />
              </div>
              <p className="font-mono text-muted-foreground break-all">{server.target}</p>
              {server.truncatedTools ? (
                <p className="text-muted-foreground">
                  <T>Tool list reached the limit; only the first tools are exposed.</T>
                </p>
              ) : null}
              {server.error !== undefined ? (
                <p className="text-destructive-foreground">{server.error}</p>
              ) : null}
              {server.reason !== undefined ? (
                <p className="text-muted-foreground">{server.reason}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {hookRows.length > 0 ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">
            <T>Hooks (Claude threads only)</T>
          </p>
          <ul className="space-y-0.5 text-muted-foreground">
            {hookRows.map(({ key, hook }) => (
              <li key={key} className="font-mono break-all">
                <span className="text-foreground">{hook.event}</span>
                {hook.matcher !== undefined ? <span> ({hook.matcher})</span> : null}
                <span>: {hook.target}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-muted-foreground">
        <T>
          MCP servers and hooks run outside the sandbox. Hooks and agents work in Claude threads.
          Only approve plugins you trust.
        </T>
      </p>
    </div>
  );
}
