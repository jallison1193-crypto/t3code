import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  isBotPaused,
  type ModelSelection,
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
  }>(() => ({ key: projectKey }));

  const currentDraft = editDraft.key === projectKey ? editDraft : { key: projectKey };
  const draftName = currentDraft.name ?? savedName;
  const draftGoal = currentDraft.goal ?? savedGoal;
  const draftModelSelection = currentDraft.modelDirty
    ? (currentDraft.modelSelection ?? null)
    : savedModelSelection;

  const isDirty =
    draftName.trim() !== savedName ||
    draftGoal.trim() !== savedGoal ||
    !Equal.equals(draftModelSelection, savedModelSelection);

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
  const triggers = (tasksQuery.data?.tasks ?? []).filter((task) => task.projectId === projectId);

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
    setSaving(true);
    const result = await updateBot({
      environmentId,
      input: {
        projectId,
        name: trimmedName,
        goal: draftGoal.trim(),
        modelSelection: draftModelSelection,
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
                    disabled={saving || !connected || draftName.trim().length === 0}
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
