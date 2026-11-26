import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { PROJECT_THREAD_BOARD_COLUMNS } from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type BotLimitMode,
  type BotLimits,
  isBotPaused,
  type ModelSelection,
  resolveBotLimits,
  type ScheduledTask,
} from "@t3tools/contracts";
import { useBlocker, useNavigate, useRouter } from "@tanstack/react-router";
import * as Equal from "effect/Equal";
import { T, useGT, useMessages } from "gt-react";
import {
  BotIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useProjectThreadBoard } from "~/components/projectHome/useProjectThreadBoard";
import {
  ScheduledTaskEditorDialog,
  ScheduledTaskRow,
} from "~/components/settings/ScheduledTasksSettings";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { resolveThreadStatusDisplay } from "~/components/ThreadStatusDot";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SidebarInset } from "~/components/ui/sidebar";
import { Textarea } from "~/components/ui/textarea";
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
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { BotModelPicker } from "./BotModelPicker";
import {
  formatBotBlockReason,
  formatBotTokenCount,
  isBotEnvironmentEnabled,
  parseBotPositiveInt,
  resolveBotEffectiveModelSelection,
  resolveBotRunNowState,
  shouldBlockBotNavigation,
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
  const member = projectGroup.memberProjects[0]!;
  const environmentId = member.environmentId;
  const projectId = member.id;
  const environment = useEnvironment(environmentId);
  const settings = environment?.serverConfig?.settings;
  const overrides = settings?.projectSettingsOverrides[projectId];
  const savedName = projectGroup.displayName;
  const savedGoal = overrides?.projectInstructions ?? "";
  const savedModelSelection: ModelSelection | null = overrides?.defaultModelSelection ?? null;
  const savedLimits = resolveBotLimits(overrides?.bot);
  const paused = isBotPaused(settings, projectId);

  const canUpdateBot = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const canDeleteBot = useAtomValue(serverEnvironment.deleteBot.permissionAtom(environmentId));
  const canOperateTasks = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
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

  // Reset local edits when switching to another bot without needing an effect.
  const [editDraft, setEditDraft] = useState<{
    readonly key: string;
    readonly name?: string;
    readonly goal?: string;
    readonly modelSelection?: ModelSelection | null;
    readonly modelDirty?: boolean;
    readonly limitMode?: BotLimitMode;
    readonly runsPerDayText?: string;
    readonly tokensPerDayText?: string;
  }>(() => ({ key: projectKey }));

  const currentDraft = editDraft.key === projectKey ? editDraft : { key: projectKey };
  const draftName = currentDraft.name ?? savedName;
  const draftGoal = currentDraft.goal ?? savedGoal;
  const draftModelSelection = currentDraft.modelDirty
    ? (currentDraft.modelSelection ?? null)
    : savedModelSelection;
  const draftLimitMode = currentDraft.limitMode ?? savedLimits.mode;
  const draftRunsPerDayText = currentDraft.runsPerDayText ?? String(savedLimits.runsPerDay);
  const draftTokensPerDayText = currentDraft.tokensPerDayText ?? String(savedLimits.tokensPerDay);
  const parsedRunsPerDay = parseBotPositiveInt(draftRunsPerDayText);
  const parsedTokensPerDay = parseBotPositiveInt(draftTokensPerDayText);
  const draftLimits: BotLimits | null =
    draftLimitMode === "none"
      ? { mode: "none" }
      : parsedRunsPerDay === null
        ? null
        : draftLimitMode === "runs_only"
          ? { mode: "runs_only", runsPerDay: parsedRunsPerDay }
          : parsedTokensPerDay === null
            ? null
            : {
                mode: "runs_and_tokens",
                runsPerDay: parsedRunsPerDay,
                tokensPerDay: parsedTokensPerDay,
              };
  const limitsValid = draftLimits !== null;
  const limitsDirty =
    draftLimitMode !== savedLimits.mode ||
    (draftLimitMode !== "none" && draftRunsPerDayText.trim() !== String(savedLimits.runsPerDay)) ||
    (draftLimitMode === "runs_and_tokens" &&
      draftTokensPerDayText.trim() !== String(savedLimits.tokensPerDay));

  const isDirty =
    draftName.trim() !== savedName ||
    draftGoal.trim() !== savedGoal ||
    !Equal.equals(draftModelSelection, savedModelSelection) ||
    limitsDirty;
  const hasUnsavedChanges = canUpdateBot && isDirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      shouldBlockBotNavigation({
        dirty: hasUnsavedChanges,
        currentPathname: current.pathname,
        nextPathname: next.pathname,
      }),
    enableBeforeUnload: () => hasUnsavedChanges,
    withResolver: true,
  });

  const [saving, setSaving] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [triggerEditor, setTriggerEditor] = useState<{
    readonly task: ScheduledTask | null;
  } | null>(null);

  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
    messages,
  );
  const usageQuery = useEnvironmentQuery(
    connected ? serverEnvironment.botUsage({ environmentId, input: { projectId } }) : null,
    messages,
  );
  const triggers = (tasksQuery.data?.tasks ?? []).filter((task) => task.projectId === projectId);
  const todayUsage = usageQuery.data?.usage ?? null;
  const blockedByPolicy = usageQuery.data?.blockedByPolicy;
  const runNowState = resolveBotRunNowState({
    botsEnabled,
    paused,
    connected,
    canOperate: canRunBot,
    dirty: canUpdateBot && isDirty,
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

  const limitModeLabels: Record<BotLimitMode, string> = {
    runs_and_tokens: gt("Runs and tokens"),
    runs_only: gt("Runs only"),
    none: gt("No limits"),
  };

  const todaySummary =
    todayUsage === null
      ? null
      : savedLimits.mode === "runs_and_tokens"
        ? gt("Today: {runs} / {runsLimit} runs · {tokens} / {tokensLimit} tokens", {
            runs: todayUsage.runs,
            runsLimit: savedLimits.runsPerDay,
            tokens: formatBotTokenCount(todayUsage.tokens),
            tokensLimit: formatBotTokenCount(savedLimits.tokensPerDay),
          })
        : savedLimits.mode === "runs_only"
          ? gt("Today: {runs} / {runsLimit} runs · {tokens} tokens", {
              runs: todayUsage.runs,
              runsLimit: savedLimits.runsPerDay,
              tokens: formatBotTokenCount(todayUsage.tokens),
            })
          : gt("Today: {runs} runs · {tokens} tokens", {
              runs: todayUsage.runs,
              tokens: formatBotTokenCount(todayUsage.tokens),
            });

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

  const handleSave = async () => {
    if (saving || !canUpdateBot || !connected || !isDirty) return;
    const trimmedName = draftName.trim();
    if (!trimmedName || /[\r\n\v\f\u0085\u2028\u2029]/u.test(trimmedName)) {
      reportError(gt("Could not save bot"), gt("Bot name must be a non-empty single line."));
      return;
    }
    if (draftLimits === null) {
      reportError(gt("Could not save bot"), gt("Daily limits must be positive whole numbers."));
      return;
    }
    setSaving(true);
    const result = await updateBot({
      environmentId,
      input: {
        projectId,
        name: trimmedName,
        goal: draftGoal.trim(),
        modelSelection: draftModelSelection,
        ...(limitsDirty ? { limits: draftLimits } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportError(gt("Could not save bot"), squashAtomCommandFailure(result));
      }
      return;
    }
    setEditDraft({ key: projectKey });
    usageQuery.refresh();
  };

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
    setEditDraft({ key: projectKey });
    void navigate({ to: "/", replace: true, ignoreBlocker: true });
  };

  const fieldsDisabled = !canUpdateBot || !connected || saving;
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
            {canUpdateBot && isDirty ? (
              <>
                <span className="hidden text-xs text-muted-foreground md:inline" role="status">
                  <T>Unsaved changes</T>
                </span>
                <span className="hidden sm:inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={saving}
                    onClick={() => setEditDraft({ key: projectKey })}
                  >
                    <T>Discard</T>
                  </Button>
                </span>
                <Button
                  type="button"
                  size="xs"
                  disabled={saving || !connected || draftName.trim().length === 0 || !limitsValid}
                  onClick={() => void handleSave()}
                >
                  {saving ? <T>Saving…</T> : <T>Save changes</T>}
                </Button>
              </>
            ) : null}
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
            <SettingsSection title={gt("Bot settings")}>
              <SettingsRow
                title={gt("Name")}
                control={
                  <div className="w-full @min-[32rem]/settings-row:w-72">
                    <Input
                      aria-label={gt("Name")}
                      disabled={fieldsDisabled}
                      maxLength={120}
                      value={draftName}
                      onChange={(event) =>
                        setEditDraft({ ...currentDraft, name: event.target.value })
                      }
                    />
                  </div>
                }
              />
              <SettingsRow
                title={gt("Model")}
                control={
                  <BotModelPicker
                    environmentId={environmentId}
                    projectId={projectId}
                    value={draftModelSelection}
                    disabled={fieldsDisabled}
                    onChange={(next) =>
                      setEditDraft({ ...currentDraft, modelSelection: next, modelDirty: true })
                    }
                  />
                }
              />
              <SettingsRow title={gt("Goal")}>
                <div className="py-2">
                  <Textarea
                    aria-label={gt("Goal")}
                    disabled={fieldsDisabled}
                    rows={3}
                    placeholder={gt("Describe what this bot should do on every run.")}
                    value={draftGoal}
                    onChange={(event) =>
                      setEditDraft({ ...currentDraft, goal: event.target.value })
                    }
                  />
                </div>
              </SettingsRow>
              <SettingsRow
                title={gt("Daily limits")}
                description={todaySummary}
                control={
                  <Select
                    value={draftLimitMode}
                    disabled={fieldsDisabled}
                    onValueChange={(next) => {
                      if (next === "runs_and_tokens" || next === "runs_only" || next === "none") {
                        setEditDraft({ ...currentDraft, limitMode: next });
                      }
                    }}
                  >
                    <SelectTrigger aria-label={gt("Daily limits")}>
                      <SelectValue>{limitModeLabels[draftLimitMode]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="runs_and_tokens">
                        {limitModeLabels.runs_and_tokens}
                      </SelectItem>
                      <SelectItem value="runs_only">{limitModeLabels.runs_only}</SelectItem>
                      <SelectItem value="none">{limitModeLabels.none}</SelectItem>
                    </SelectPopup>
                  </Select>
                }
              >
                {draftLimitMode === "none" ? null : (
                  <div className="grid gap-3 pt-3 pb-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="bot-home-runs-limit">
                        <T>Runs per day</T>
                      </Label>
                      <Input
                        id="bot-home-runs-limit"
                        type="number"
                        min={1}
                        step={1}
                        disabled={fieldsDisabled}
                        aria-invalid={parsedRunsPerDay === null}
                        value={draftRunsPerDayText}
                        onChange={(event) =>
                          setEditDraft({ ...currentDraft, runsPerDayText: event.target.value })
                        }
                      />
                    </div>
                    {draftLimitMode === "runs_and_tokens" ? (
                      <div className="space-y-1">
                        <Label htmlFor="bot-home-tokens-limit">
                          <T>Tokens per day</T>
                        </Label>
                        <Input
                          id="bot-home-tokens-limit"
                          type="number"
                          min={1}
                          step={100000}
                          disabled={fieldsDisabled}
                          aria-invalid={parsedTokensPerDay === null}
                          aria-describedby="bot-home-tokens-hint"
                          value={draftTokensPerDayText}
                          onChange={(event) =>
                            setEditDraft({ ...currentDraft, tokensPerDayText: event.target.value })
                          }
                        />
                        <p id="bot-home-tokens-hint" className="text-xs text-muted-foreground">
                          {parsedTokensPerDay === null
                            ? null
                            : formatBotTokenCount(parsedTokensPerDay)}
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </SettingsRow>
            </SettingsSection>

            <SettingsSection
              title={gt("Triggers")}
              headerAction={
                canOperateTasks ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={!connected}
                    onClick={() => setTriggerEditor({ task: null })}
                  >
                    <PlusIcon className="size-3.5" />
                    <T>Add trigger</T>
                  </Button>
                ) : null
              }
            >
              {!connected ? (
                <SettingsRow
                  title={gt("Environment disconnected")}
                  description={gt("Reconnect this environment to manage triggers.")}
                />
              ) : tasksQuery.error ? (
                <SettingsRow
                  title={gt("Could not load scheduled tasks")}
                  description={tasksQuery.error}
                />
              ) : tasksQuery.data === null ? (
                <SettingsRow title={gt("Loading triggers…")} role="status" />
              ) : triggers.length === 0 ? (
                <SettingsRow
                  title={gt("No triggers yet")}
                  description={gt("Add a schedule or webhook to run this bot automatically.")}
                />
              ) : (
                triggers.map((task) => (
                  <ScheduledTaskRow
                    key={task.id}
                    environmentId={environmentId}
                    task={task}
                    timeZone={tasksQuery.data?.timeZone}
                    botPage
                    onEdit={() => setTriggerEditor({ task })}
                  />
                ))
              )}
            </SettingsSection>

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
                        params: { environmentId: thread.environmentId, threadId: thread.id },
                      });
                    }}
                  />
                ))
              )}
            </SettingsSection>
          </div>
        </div>
      </div>

      {triggerEditor !== null ? (
        <ScheduledTaskEditorDialog
          initialEnvironmentId={environmentId}
          task={triggerEditor.task}
          fixedProject={{
            environmentId,
            projectId,
            defaultThreadMode: "new_thread",
          }}
          onClose={() => setTriggerEditor(null)}
        />
      ) : null}

      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Discard unsaved changes?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>Your changes to this bot have not been saved.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Keep editing</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setEditDraft({ key: projectKey });
                blocker.proceed?.();
              }}
            >
              <T>Discard</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarInset>
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
