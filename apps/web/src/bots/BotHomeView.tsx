import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
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
import { useNavigate } from "@tanstack/react-router";
import * as Equal from "effect/Equal";
import { T, useGT, useMessages } from "gt-react";
import { BotIcon, PauseIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ProjectThreadBoardContent } from "~/components/projectHome/ProjectThreadsView";
import { useProjectThreadBoard } from "~/components/projectHome/useProjectThreadBoard";
import {
  ScheduledTaskEditorDialog,
  ScheduledTaskRow,
} from "~/components/settings/ScheduledTasksSettings";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
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
import { requestConfirmDialog } from "~/confirmDialog";
import { isElectron } from "~/env";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { BotModelPicker } from "./BotModelPicker";
import { formatBotTokenCount, parseBotPositiveInt } from "./bots.logic";

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
  const limitsValid =
    draftLimitMode === "none" ||
    (parsedRunsPerDay !== null && (draftLimitMode === "runs_only" || parsedTokensPerDay !== null));
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

  const [saving, setSaving] = useState(false);
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

  const { columns, openCount, digest } = useProjectThreadBoard(projectKey);

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
    if (!limitsValid) {
      reportError(gt("Could not save bot"), gt("Daily limits must be positive whole numbers."));
      return;
    }
    const nextLimits: BotLimits =
      draftLimitMode === "none"
        ? { mode: "none" }
        : draftLimitMode === "runs_only"
          ? { mode: "runs_only", runsPerDay: parsedRunsPerDay! }
          : {
              mode: "runs_and_tokens",
              runsPerDay: parsedRunsPerDay!,
              tokensPerDay: parsedTokensPerDay!,
            };
    setSaving(true);
    const result = await updateBot({
      environmentId,
      input: {
        projectId,
        name: trimmedName,
        goal: draftGoal.trim(),
        modelSelection: draftModelSelection,
        ...(limitsDirty ? { limits: nextLimits } : {}),
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
    void navigate({ to: "/", replace: true });
  };

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
              <Button
                variant="destructive-outline"
                size="xs"
                disabled={!connected || deleting || togglingPause}
                onClick={() => void handleDelete()}
              >
                <Trash2Icon className="size-3.5" />
                <T>Delete</T>
              </Button>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 sm:px-6">
            <section
              aria-label={gt("Bot settings")}
              className="space-y-4 rounded-xl border bg-card p-4"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="bot-home-name">
                    <T>Name</T>
                  </Label>
                  <Input
                    id="bot-home-name"
                    disabled={!canUpdateBot || !connected || saving}
                    maxLength={120}
                    value={draftName}
                    onChange={(event) =>
                      setEditDraft({ ...currentDraft, name: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    <T>Model</T>
                  </Label>
                  <BotModelPicker
                    environmentId={environmentId}
                    projectId={projectId}
                    value={draftModelSelection}
                    disabled={!canUpdateBot || !connected || saving}
                    onChange={(next) =>
                      setEditDraft({
                        ...currentDraft,
                        modelSelection: next,
                        modelDirty: true,
                      })
                    }
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="bot-home-goal">
                  <T>Goal</T>
                </Label>
                <Textarea
                  id="bot-home-goal"
                  disabled={!canUpdateBot || !connected || saving}
                  rows={3}
                  placeholder={gt("Describe what this bot should do on every run.")}
                  value={draftGoal}
                  onChange={(event) => setEditDraft({ ...currentDraft, goal: event.target.value })}
                />
              </div>

              <div className="space-y-2 border-t border-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="bot-home-limits-mode">
                    <T>Limits</T>
                  </Label>
                  {todaySummary !== null ? (
                    <p className="text-xs text-muted-foreground">{todaySummary}</p>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="bot-home-limits-mode">
                      <T>Daily cap</T>
                    </Label>
                    <Select
                      value={draftLimitMode}
                      disabled={!canUpdateBot || !connected || saving}
                      onValueChange={(next) => {
                        if (next === "runs_and_tokens" || next === "runs_only" || next === "none") {
                          setEditDraft({ ...currentDraft, limitMode: next });
                        }
                      }}
                    >
                      <SelectTrigger id="bot-home-limits-mode">
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
                  </div>
                  {draftLimitMode !== "none" ? (
                    <div className="space-y-1">
                      <Label htmlFor="bot-home-runs-limit">
                        <T>Runs per day</T>
                      </Label>
                      <Input
                        id="bot-home-runs-limit"
                        type="number"
                        min={1}
                        step={1}
                        disabled={!canUpdateBot || !connected || saving}
                        aria-invalid={parsedRunsPerDay === null}
                        value={draftRunsPerDayText}
                        onChange={(event) =>
                          setEditDraft({ ...currentDraft, runsPerDayText: event.target.value })
                        }
                      />
                    </div>
                  ) : null}
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
                        disabled={!canUpdateBot || !connected || saving}
                        aria-invalid={parsedTokensPerDay === null}
                        value={draftTokensPerDayText}
                        onChange={(event) =>
                          setEditDraft({ ...currentDraft, tokensPerDayText: event.target.value })
                        }
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              {canUpdateBot && isDirty ? (
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={saving}
                    onClick={() => setEditDraft({ key: projectKey })}
                  >
                    <T>Discard</T>
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    disabled={saving || !connected || draftName.trim().length === 0 || !limitsValid}
                    onClick={() => void handleSave()}
                  >
                    {saving ? <T>Saving…</T> : <T>Save changes</T>}
                  </Button>
                </div>
              ) : null}
            </section>

            <section aria-label={gt("Triggers")} className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-medium text-foreground">
                    <T>Triggers</T>
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    <T>Schedules and webhooks that start a new run for this bot.</T>
                  </p>
                </div>
                {canOperateTasks ? (
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
                ) : null}
              </div>

              {!connected ? (
                <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
                  <T>Reconnect this environment to manage triggers.</T>
                </p>
              ) : tasksQuery.error ? (
                <p className="rounded-xl border bg-card px-4 py-3 text-sm text-destructive">
                  {tasksQuery.error}
                </p>
              ) : tasksQuery.data === null ? (
                <p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
                  <T>Loading triggers…</T>
                </p>
              ) : triggers.length === 0 ? (
                <div className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
                  <T>No triggers yet. Add a schedule or webhook to run this bot automatically.</T>
                </div>
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-xl border bg-card">
                  {triggers.map((task) => (
                    <ScheduledTaskRow
                      key={task.id}
                      environmentId={environmentId}
                      task={task}
                      timeZone={tasksQuery.data?.timeZone}
                      onEdit={() => setTriggerEditor({ task })}
                    />
                  ))}
                </div>
              )}
            </section>

            <section aria-label={gt("Runs")} className="flex min-h-72 flex-col space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-foreground">
                  <T>Runs</T>
                </h2>
              </div>
              <div className="flex min-h-72 flex-1 flex-col overflow-hidden rounded-xl border bg-card/40">
                <ProjectThreadBoardContent
                  columns={columns}
                  openCount={openCount}
                  digest={digest}
                  onOpenThread={(thread) => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId: thread.environmentId, threadId: thread.id },
                    });
                  }}
                  emptyTitle={<T>No runs yet</T>}
                  emptyDescription={
                    <T>
                      Each trigger run starts its own thread here so you can review or reply to it.
                    </T>
                  }
                />
              </div>
            </section>
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
    </SidebarInset>
  );
}
