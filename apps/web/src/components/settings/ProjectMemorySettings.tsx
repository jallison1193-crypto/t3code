import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  formatMemoryByteSize,
  formatProjectMemoryError,
  validateMemoryByteLimit,
} from "@t3tools/client-runtime/project-memory";
import { PROJECT_MEMORY_MAX_BYTES, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

function ProjectMemoryEditor({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const m = useMessages();
  const setting = searchableSetting("project-memory");
  const memoryAtom = projectEnvironment.memoryGet({
    environmentId,
    input: { projectId },
  });
  const memoryResult = useAtomValue(memoryAtom);
  const refreshMemory = useAtomRefresh(memoryAtom);
  const canEdit = useAtomValue(projectEnvironment.memorySet.permissionAtom(environmentId));
  const setMemory = useAtomCommand(projectEnvironment.memorySet, { reportFailure: false });

  const targetKey = `${environmentId}:${projectId}`;
  const [draft, setDraft] = useState<{
    readonly targetKey: string;
    readonly text: string;
  } | null>(null);
  const [optimisticSaved, setOptimisticSaved] = useState<{
    readonly targetKey: string;
    readonly content: string;
    readonly updatedAt: string;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<{
    readonly targetKey: string;
    readonly message: string;
  } | null>(null);

  const memoryData = AsyncResult.getOrElse(memoryResult, () => null);
  const serverContent = memoryData?.content ?? "";
  const hasMatchingOptimistic =
    optimisticSaved !== null &&
    optimisticSaved.targetKey === targetKey &&
    (memoryResult.waiting || memoryData?.updatedAt === optimisticSaved.updatedAt);
  const baseContent = hasMatchingOptimistic ? optimisticSaved.content : serverContent;

  const activeDraft = draft !== null && draft.targetKey === targetKey ? draft : null;
  const currentText = activeDraft ? activeDraft.text : baseContent;
  const isDirty = activeDraft !== null && activeDraft.text !== baseContent;
  const { byteLength, valid: withinLimit } = validateMemoryByteLimit(currentText);
  const isInitialLoading = AsyncResult.isInitial(memoryResult);
  const loadFailure = AsyncResult.isFailure(memoryResult) ? memoryResult.cause : null;
  const visibleSaveError =
    saveError !== null && saveError.targetKey === targetKey ? saveError.message : null;
  const isEmpty = memoryData !== null && !memoryData.exists && currentText.length === 0;

  const handleSave = async () => {
    if (!canEdit || isSaving || !withinLimit || !isDirty) return;
    setIsSaving(true);
    setSaveError(null);
    const result = await setMemory({
      environmentId,
      input: { projectId, content: currentText },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      setSaveError({
        targetKey,
        message: formatProjectMemoryError(result.cause, gt("Failed to save project memory.")),
      });
      return;
    }
    setOptimisticSaved({
      targetKey,
      content: currentText,
      updatedAt: result.value.updatedAt,
    });
    setDraft(null);
  };

  return (
    <SettingsRow
      id={setting.id}
      title={m(setting.title)}
      description={gt(
        "Markdown notes stored in MEMORY.md for this project. Agents in this project also read and update this file.",
      )}
    >
      <div className="mt-3 max-w-2xl space-y-2.5 pb-3.5">
        {isInitialLoading ? (
          <p className="text-xs text-muted-foreground">{gt("Loading MEMORY.md...")}</p>
        ) : loadFailure !== null ? (
          <Alert variant="error">
            <AlertDescription>
              {formatProjectMemoryError(loadFailure, gt("Could not load project memory."))}
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" type="button" onClick={() => refreshMemory()}>
                {gt("Retry")}
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <>
            <Textarea
              aria-label={m(setting.title)}
              rows={8}
              value={currentText}
              disabled={!canEdit || isSaving}
              placeholder={gt(
                "No project memory saved yet. Add Markdown notes, conventions, or context for agents working in this project.",
              )}
              onChange={(event) => {
                setSaveError(null);
                setOptimisticSaved(null);
                setDraft({ targetKey, text: event.target.value });
              }}
            />
            {isEmpty ? (
              <p className="text-xs text-muted-foreground">
                {gt("MEMORY.md has not been created yet. Saving will create it.")}
              </p>
            ) : null}
            {!canEdit ? (
              <p className="text-xs text-muted-foreground">
                {gt("This connection does not have permission to edit project memory.")}
              </p>
            ) : null}
            {!withinLimit ? (
              <Alert variant="error">
                <AlertDescription>
                  {gt("Project memory exceeds the {limit} UTF-8 byte limit.", {
                    limit: formatMemoryByteSize(PROJECT_MEMORY_MAX_BYTES),
                  })}
                </AlertDescription>
              </Alert>
            ) : null}
            {visibleSaveError !== null ? (
              <Alert variant="error">
                <AlertDescription>{visibleSaveError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className={
                  withinLimit
                    ? "text-xs text-muted-foreground"
                    : "text-xs font-medium text-destructive"
                }
              >
                {gt("{used} / {max} bytes", {
                  used: byteLength.toLocaleString(),
                  max: PROJECT_MEMORY_MAX_BYTES.toLocaleString(),
                })}
              </span>
              <div className="flex items-center gap-2">
                {isDirty ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    disabled={isSaving}
                    onClick={() => {
                      setSaveError(null);
                      setDraft(null);
                    }}
                  >
                    {gt("Discard")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  type="button"
                  disabled={!canEdit || isSaving || !isDirty || !withinLimit}
                  onClick={() => void handleSave()}
                >
                  {isSaving ? gt("Saving...") : gt("Save memory")}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </SettingsRow>
  );
}

export function ProjectMemorySettings() {
  const gt = useGT();
  const m = useMessages();
  const scopeContext = useOptionalSettingsScope();
  if (scopeContext === null) return null;
  if (scopeContext.scope.kind !== "project" && scopeContext.scope.kind !== "checkout") return null;
  if (scopeContext.scope.members.length !== 1) return null;

  const target =
    scopeContext.targets.length === 1 && scopeContext.targets[0]?.projectId != null
      ? scopeContext.targets[0]
      : null;
  if (target === null || target.projectId === null) {
    const setting = searchableSetting("project-memory");
    return (
      <SettingsRow
        id={setting.id}
        title={m(setting.title)}
        description={gt("Reconnect the selected environment to view and edit project memory.")}
      />
    );
  }

  return <ProjectMemoryEditor environmentId={target.environmentId} projectId={target.projectId} />;
}
