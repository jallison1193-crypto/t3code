import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type BotApprovalsMode,
  type BotLimitMode,
  type BotLimits,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  resolveBotApprovalsMode,
  resolveBotLimits,
  type ScheduledTask,
} from "@t3tools/contracts";
import { useBlocker } from "@tanstack/react-router";
import * as Equal from "effect/Equal";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  ScheduledTaskEditorDialog,
  ScheduledTaskRow,
} from "~/components/settings/ScheduledTasksSettings";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { BotLimitModeSelect, BotLimitNumberInputs } from "./BotLimitsControls";
import { BotModelPicker } from "./BotModelPicker";
import {
  botSettingsSelectionKeyFromSearch,
  formatBotTodayUsage,
  isBotEnvironmentEnabled,
  parseBotPositiveInt,
  shouldBlockBotNavigation,
} from "./bots.logic";

interface BotSettingsPanelRenderProps {
  readonly hasUnsavedChanges: boolean;
  readonly saveBar: ReactNode;
  readonly content: ReactNode;
}

export function BotSettingsPanel({
  botKey,
  environmentId,
  projectId,
  savedName,
  renderContainer,
}: {
  readonly botKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly savedName: string;
  readonly renderContainer?: (props: BotSettingsPanelRenderProps) => ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const environment = useEnvironment(environmentId);
  const settings = environment?.serverConfig?.settings;
  const overrides = settings?.projectSettingsOverrides[projectId];
  const savedGoal = overrides?.projectInstructions ?? "";
  const savedModelSelection: ModelSelection | null = overrides?.defaultModelSelection ?? null;
  const savedLimits = resolveBotLimits(overrides?.bot);
  const savedApprovals = resolveBotApprovalsMode(overrides?.bot);

  const canUpdateBot = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const canOperateTasks = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const botsEnabled = isBotEnvironmentEnabled(settings);

  const updateBot = useAtomCommand(serverEnvironment.updateBot, {
    label: "bot update",
    reportFailure: false,
  });

  // Reset local edits when switching to another bot without needing an effect.
  const [editDraft, setEditDraft] = useState<{
    readonly key: string;
    readonly name?: string;
    readonly goal?: string;
    readonly modelSelection?: ModelSelection | null;
    readonly modelDirty?: boolean;
    readonly approvals?: BotApprovalsMode;
    readonly limitMode?: BotLimitMode;
    readonly runsPerDayText?: string;
    readonly tokensPerDayText?: string;
  }>(() => ({ key: botKey }));
  const [confirmProviderBotKey, setConfirmProviderBotKey] = useState<string | null>(null);
  const confirmProviderApprovals = confirmProviderBotKey === botKey;

  const currentDraft = editDraft.key === botKey ? editDraft : { key: botKey };
  const draftName = currentDraft.name ?? savedName;
  const draftGoal = currentDraft.goal ?? savedGoal;
  const draftModelSelection = currentDraft.modelDirty
    ? (currentDraft.modelSelection ?? null)
    : savedModelSelection;
  const draftApprovals = currentDraft.approvals ?? savedApprovals;
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
  const approvalsDirty = draftApprovals !== savedApprovals;

  const isDirty =
    draftName.trim() !== savedName ||
    draftGoal.trim() !== savedGoal ||
    !Equal.equals(draftModelSelection, savedModelSelection) ||
    approvalsDirty ||
    limitsDirty;
  const hasUnsavedChanges = canUpdateBot && botsEnabled && isDirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      shouldBlockBotNavigation({
        dirty: hasUnsavedChanges,
        currentPathname: current.pathname,
        nextPathname: next.pathname,
        currentSelectionKey: botSettingsSelectionKeyFromSearch(current.search),
        nextSelectionKey: botSettingsSelectionKeyFromSearch(next.search),
      }),
    enableBeforeUnload: () => hasUnsavedChanges,
    withResolver: true,
  });

  const [saving, setSaving] = useState(false);
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
  const todaySummary = formatBotTodayUsage(usageQuery.data?.usage, savedLimits, messages);

  const reportError = (title: string, error: unknown) => {
    const description =
      error instanceof Error
        ? (thrownErrorMessage(error, messages) ?? error.message)
        : String(error);
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  };

  const handleSave = async () => {
    if (saving || !canUpdateBot || !connected || !botsEnabled || !isDirty) return;
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
        ...(approvalsDirty ? { approvals: draftApprovals } : {}),
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
    setEditDraft({ key: botKey });
    usageQuery.refresh();
  };

  const fieldsDisabled = !canUpdateBot || !connected || !botsEnabled || saving;
  const saveBar = hasUnsavedChanges ? (
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
          onClick={() => setEditDraft({ key: botKey })}
        >
          <T>Discard</T>
        </Button>
      </span>
      <Button
        type="button"
        size="xs"
        disabled={
          saving || !connected || !botsEnabled || draftName.trim().length === 0 || !limitsValid
        }
        onClick={() => void handleSave()}
      >
        {saving ? <T>Saving…</T> : <T>Save changes</T>}
      </Button>
    </>
  ) : null;

  const approvalsLabels: Record<BotApprovalsMode, string> = {
    t3_gate: gt("T3 safety gate (recommended)"),
    provider: gt("Provider's own approvals (less safe)"),
  };

  const content = (
    <>
      {!botsEnabled ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4" role="status">
          <T>Bots are turned off. Turn Bots on to edit this bot or its triggers.</T>
        </p>
      ) : null}
      <SettingsSection
        title={gt("Bot settings")}
        headerAction={
          renderContainer === undefined && saveBar !== null ? (
            <div className="flex items-center gap-1.5">{saveBar}</div>
          ) : undefined
        }
      >
        <SettingsRow
          title={gt("Name")}
          control={
            <div className="w-full @min-[32rem]/settings-row:w-72">
              <Input
                aria-label={gt("Name")}
                disabled={fieldsDisabled}
                maxLength={120}
                value={draftName}
                onChange={(event) => setEditDraft({ ...currentDraft, name: event.target.value })}
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
              approvals={draftApprovals}
              disabled={fieldsDisabled}
              onChange={(next) =>
                setEditDraft({ ...currentDraft, modelSelection: next, modelDirty: true })
              }
            />
          }
        />
        <SettingsRow
          title={
            draftApprovals === "provider" ? (
              <span className="inline-flex items-center gap-1.5">
                <T>Approvals</T>
                <Badge variant="warning" size="sm">
                  <T>Less safe</T>
                </Badge>
              </span>
            ) : (
              gt("Approvals")
            )
          }
          description={gt(
            "T3's safety gate asks before sending, deleting, fetching URLs, or changing agent settings. Provider's own approvals unlocks unsupported providers and changes nothing for supported providers.",
          )}
          control={
            <Select
              value={draftApprovals}
              disabled={fieldsDisabled}
              onValueChange={(next) => {
                if (next === "t3_gate") {
                  setEditDraft({ ...currentDraft, approvals: "t3_gate" });
                } else if (next === "provider" && draftApprovals !== "provider") {
                  setConfirmProviderBotKey(botKey);
                }
              }}
            >
              <SelectTrigger aria-label={gt("Approvals")}>
                <SelectValue>{approvalsLabels[draftApprovals]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="t3_gate">{approvalsLabels.t3_gate}</SelectItem>
                <SelectItem value="provider">{approvalsLabels.provider}</SelectItem>
              </SelectPopup>
            </Select>
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
              onChange={(event) => setEditDraft({ ...currentDraft, goal: event.target.value })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title={gt("Daily limits")}
          description={todaySummary}
          control={
            <BotLimitModeSelect
              value={draftLimitMode}
              disabled={fieldsDisabled}
              ariaLabel={gt("Daily limits")}
              onChange={(next) => setEditDraft({ ...currentDraft, limitMode: next })}
            />
          }
        >
          <BotLimitNumberInputs
            idPrefix="bot-home"
            mode={draftLimitMode}
            disabled={fieldsDisabled}
            runsText={draftRunsPerDayText}
            tokensText={draftTokensPerDayText}
            onRunsChange={(value) => setEditDraft({ ...currentDraft, runsPerDayText: value })}
            onTokensChange={(value) => setEditDraft({ ...currentDraft, tokensPerDayText: value })}
          />
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
              disabled={!connected || !botsEnabled}
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
    </>
  );

  return (
    <>
      {renderContainer ? renderContainer({ hasUnsavedChanges, saveBar, content }) : content}

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
                setEditDraft({ key: botKey });
                blocker.proceed?.();
              }}
            >
              <T>Discard</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={confirmProviderApprovals}
        onOpenChange={(open) => {
          if (!open) setConfirmProviderBotKey(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Use provider's own approvals?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The provider's own settings decide what runs without asking, so this bot may send,
                delete, or change things without T3 asking first. T3 still checks approvals that
                reach it and blocks paying.
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
                setEditDraft({ ...currentDraft, approvals: "provider" });
                setConfirmProviderBotKey(null);
              }}
            >
              <T>Use provider's own approvals</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
