import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { PROJECT_THREAD_BOARD_COLUMNS } from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isBotPaused, type ModelSelection } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  BotIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useProjectThreadBoard } from "~/components/projectHome/useProjectThreadBoard";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { resolveThreadStatusDisplay } from "~/components/ThreadStatusDot";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { SidebarInset } from "~/components/ui/sidebar";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import { providerInstanceEntriesFor } from "~/providerInstances";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { waitForThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { BotSettingsPanel } from "./BotSettingsPanel";
import {
  formatBotBlockReason,
  isBotEnvironmentEnabled,
  resolveBotEffectiveModelSelection,
  resolveBotRunNowState,
} from "./bots.logic";

export function BotHomeView({
  projectKey,
  projectGroup,
}: {
  readonly projectKey: string;
  readonly projectGroup: SidebarProjectSnapshot;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const router = useRouter();
  const member = projectGroup.memberProjects[0];
  const environmentId = member?.environmentId ?? projectGroup.environmentId;
  const projectId = member?.id ?? projectGroup.id;
  const environment = useEnvironment(environmentId);
  const settings = environment?.serverConfig?.settings;
  const overrides = settings?.projectSettingsOverrides[projectId];
  const savedName = projectGroup.displayName;
  const savedModelSelection: ModelSelection | null = overrides?.defaultModelSelection ?? null;
  const paused = isBotPaused(settings, projectId);

  const canUpdateBot = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const canDeleteBot = useAtomValue(serverEnvironment.deleteBot.permissionAtom(environmentId));
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const botsEnabled = isBotEnvironmentEnabled(settings);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = settings
    ? providerInstanceEntriesFor(providers, settings, projectId)
    : [];
  const effectiveModel = resolveBotEffectiveModelSelection({
    botModelSelection: savedModelSelection,
    environmentDefaultModelSelection: settings?.defaultModelSelection,
    instanceEntries,
  });
  const canRunBot = useAtomValue(serverEnvironment.runBot.permissionAtom(environmentId));

  const runBot = useAtomCommand(serverEnvironment.runBot, {
    label: "bot run",
    reportFailure: false,
  });
  const updateBot = useAtomCommand(serverEnvironment.updateBot, {
    label: "bot update",
    reportFailure: false,
  });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, {
    label: "bot delete",
    reportFailure: false,
  });

  const [startingRun, setStartingRun] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const usageQuery = useEnvironmentQuery(
    connected ? serverEnvironment.botUsage({ environmentId, input: { projectId } }) : null,
    messages,
  );
  const blockedByPolicy = usageQuery.data?.blockedByPolicy;

  const { columns } = useProjectThreadBoard(projectKey);
  const runs = PROJECT_THREAD_BOARD_COLUMNS.flatMap((column) => columns[column]).toSorted(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );

  const reportError = (title: string, error: unknown) => {
    const description =
      error instanceof Error
        ? (thrownErrorMessage(error, messages) ?? error.message)
        : String(error);
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  };

  const handleTogglePause = async () => {
    if (togglingPause || !canUpdateBot || !connected) return;
    setTogglingPause(true);
    const result = await updateBot({
      environmentId,
      input: {
        projectId,
        paused: !paused,
      },
    });
    setTogglingPause(false);
    usageQuery.refresh();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportError(
        paused ? gt("Could not resume bot") : gt("Could not pause bot"),
        squashAtomCommandFailure(result),
      );
    }
  };

  const handleDelete = async () => {
    if (deleting || !canDeleteBot || !connected) return;
    const message = `${gt('Delete bot "{name}"?', { name: savedName })}\n${gt("This removes its runs and scheduled triggers and cannot be undone.")}`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setDeleting(true);
    const result = await deleteBot({
      environmentId,
      input: { projectId },
    });
    setDeleting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportError(gt("Could not delete bot"), squashAtomCommandFailure(result));
      }
      return;
    }
    void navigate({ to: "/", replace: true, ignoreBlocker: true });
  };

  return (
    <BotSettingsPanel
      botKey={projectKey}
      environmentId={environmentId}
      projectId={projectId}
      savedName={savedName}
      renderContainer={({ hasUnsavedChanges, saveBar, content }) => {
        const runNowState = resolveBotRunNowState({
          botsEnabled,
          paused,
          connected,
          canOperate: canRunBot,
          dirty: hasUnsavedChanges,
          blockedByPolicy,
        });
        const runNowDisabledReason =
          runNowState.reason === "bots_off"
            ? gt("Bots are off")
            : runNowState.reason === "paused"
              ? gt("Bot is paused")
              : runNowState.reason === "blocked" && blockedByPolicy !== undefined
                ? formatBotBlockReason(blockedByPolicy, messages)
                : null;

        const handleRunNow = async () => {
          if (startingRun || runNowState.disabled) return;
          setStartingRun(true);
          const startedFrom = router.latestLocation;
          const result = await runBot({
            environmentId,
            input: {
              projectId,
              prompt: gt("Do your goal now."),
              ...(effectiveModel.selection === null
                ? {}
                : { fallbackModelSelection: effectiveModel.selection }),
            },
          });
          if (result._tag === "Failure") {
            setStartingRun(false);
            usageQuery.refresh();
            if (!isAtomCommandInterrupted(result)) {
              reportError(gt("Could not start run"), squashAtomCommandFailure(result));
            }
            return;
          }
          const ref = scopeThreadRef(environmentId, result.value.threadId);
          const arrived = await waitForThreadShell(ref);
          setStartingRun(false);
          usageQuery.refresh();
          // Opening the run must not pull the user back from wherever they went while it started.
          if (arrived && router.latestLocation === startedFrom) {
            void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
          }
        };

        const runNowButton = (
          <Button
            type="button"
            size="xs"
            disabled={runNowState.disabled || startingRun || togglingPause || deleting}
            aria-describedby={runNowDisabledReason !== null ? "bot-run-now-reason" : undefined}
            onClick={() => void handleRunNow()}
          >
            <PlayIcon className="size-3.5" />
            <T>Run now</T>
          </Button>
        );

        return (
          <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
              <WorkspacePageHeader electron={isElectron} className="bg-background">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <h1 className="truncate text-sm font-medium text-foreground">{savedName}</h1>
                  {paused ? (
                    <Badge variant="outline" size="sm">
                      <T>Paused</T>
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {saveBar}
                  {runNowDisabledReason !== null ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            id="bot-run-now-reason"
                            className="max-w-56 truncate text-xs text-muted-foreground"
                            tabIndex={0}
                          />
                        }
                      >
                        {runNowDisabledReason}
                      </TooltipTrigger>
                      <TooltipPopup>{runNowDisabledReason}</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {runNowState.reason === "unsaved" ? (
                    <Tooltip>
                      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
                        {runNowButton}
                      </TooltipTrigger>
                      <TooltipPopup>
                        <T>Save changes first</T>
                      </TooltipPopup>
                    </Tooltip>
                  ) : (
                    runNowButton
                  )}
                  {canUpdateBot ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!connected || togglingPause || deleting}
                      onClick={() => void handleTogglePause()}
                    >
                      {paused ? (
                        <>
                          <PlayIcon className="size-3.5" />
                          <T>Resume</T>
                        </>
                      ) : (
                        <>
                          <PauseIcon className="size-3.5" />
                          <T>Pause</T>
                        </>
                      )}
                    </Button>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={gt("Bot settings")}
                          onClick={() =>
                            void navigate({
                              to: "/settings/bots",
                              search: { bot: projectId, env: environmentId },
                            })
                          }
                        />
                      }
                    >
                      <SettingsIcon className="size-4" />
                    </TooltipTrigger>
                    <TooltipPopup>{gt("Bot settings")}</TooltipPopup>
                  </Tooltip>
                  {canDeleteBot ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={!connected || deleting || togglingPause}
                            aria-label={gt("Actions for {title}", { title: savedName })}
                          />
                        }
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => void handleDelete()}>
                          <Trash2Icon />
                          <T>Delete</T>
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </div>
              </WorkspacePageHeader>

              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6">
                  {content}

                  <SettingsSection title={gt("Runs")}>
                    {runs.length === 0 ? (
                      <SettingsRow
                        title={gt("No runs yet")}
                        description={gt(
                          "Each run starts its own thread here so you can review or reply to it.",
                        )}
                      />
                    ) : (
                      runs.map((thread) => (
                        <BotRunRow
                          key={thread.id}
                          thread={thread}
                          onOpen={() => {
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: {
                                environmentId: thread.environmentId,
                                threadId: thread.id,
                              },
                            });
                          }}
                        />
                      ))
                    )}
                  </SettingsSection>
                </div>
              </div>
            </div>
          </SidebarInset>
        );
      }}
    />
  );
}

function BotRunRow({
  thread,
  onOpen,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly onOpen: () => void;
}) {
  const messages = useMessages();
  const status = resolveThreadStatusDisplay(thread);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none sm:px-4"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{thread.title}</span>
      <span className={`shrink-0 text-xs ${status.colorClass}`}>{messages(status.label)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTimeLabel(thread.updatedAt)}
      </span>
    </button>
  );
}
