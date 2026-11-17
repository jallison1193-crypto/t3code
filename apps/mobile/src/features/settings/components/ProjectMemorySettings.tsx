import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  formatMemoryByteSize,
  formatProjectMemoryError,
  validateMemoryByteLimit,
} from "@t3tools/client-runtime/project-memory";
import { PROJECT_MEMORY_MAX_BYTES, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { projectEnvironment } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

function ProjectMemoryConnectedEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const memoryAtom = projectEnvironment.memoryGet({
    environmentId: props.environmentId,
    input: { projectId: props.projectId },
  });
  const memoryResult = useAtomValue(memoryAtom);
  const refreshMemory = useAtomRefresh(memoryAtom);
  const canEdit = useAtomValue(projectEnvironment.memorySet.permissionAtom(props.environmentId));
  const setMemory = useAtomCommand(projectEnvironment.memorySet, { reportFailure: false });

  const targetKey = `${props.environmentId}:${props.projectId}`;
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
      environmentId: props.environmentId,
      input: { projectId: props.projectId, content: currentText },
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
    <SettingsSection
      title={gt("Project memory")}
      footer={gt("Agents in this project also read and update MEMORY.md.")}
    >
      <View className="gap-2.5 px-4 py-3">
        {isInitialLoading ? (
          <View className="flex-row items-center gap-2 py-2">
            <AppActivityIndicator />
            <Text className="text-sm text-foreground-muted">{gt("Loading MEMORY.md...")}</Text>
          </View>
        ) : loadFailure !== null ? (
          <View className="gap-2">
            <Text className="text-sm text-danger">
              {formatProjectMemoryError(loadFailure, gt("Could not load project memory."))}
            </Text>
            <Button
              label={gt("Retry")}
              size="compact"
              tone="secondary"
              onPress={() => refreshMemory()}
            />
          </View>
        ) : (
          <>
            <AppTextInput
              accessibilityLabel={gt("Project memory")}
              value={currentText}
              onChangeText={(text) => {
                setSaveError(null);
                setOptimisticSaved(null);
                setDraft({ targetKey, text });
              }}
              placeholder={gt("Add Markdown notes for MEMORY.md in this project.")}
              editable={canEdit && !isSaving}
              multiline
              autoCapitalize="sentences"
              className="min-h-32 rounded-xl px-3 py-2 text-base text-foreground"
            />
            {isEmpty ? (
              <Text className="text-xs text-foreground-muted">
                {gt("MEMORY.md has not been created yet. Saving will create it.")}
              </Text>
            ) : null}
            {!canEdit ? (
              <Text className="text-xs text-foreground-muted">
                {gt("This connection does not have permission to edit project memory.")}
              </Text>
            ) : null}
            {!withinLimit ? (
              <Text className="text-xs text-danger">
                {gt("Project memory exceeds the {limit} UTF-8 byte limit.", {
                  limit: formatMemoryByteSize(PROJECT_MEMORY_MAX_BYTES),
                })}
              </Text>
            ) : null}
            {visibleSaveError !== null ? (
              <Text className="text-xs text-danger">{visibleSaveError}</Text>
            ) : null}
            <View className="flex-row flex-wrap items-center justify-between gap-2">
              <Text
                className={withinLimit ? "text-xs text-foreground-muted" : "text-xs text-danger"}
              >
                {gt("{used} / {max} bytes", {
                  used: byteLength.toLocaleString(),
                  max: PROJECT_MEMORY_MAX_BYTES.toLocaleString(),
                })}
              </Text>
              <View className="flex-row items-center gap-2">
                {isDirty ? (
                  <Button
                    label={gt("Discard")}
                    size="compact"
                    tone="text"
                    disabled={isSaving}
                    onPress={() => {
                      setSaveError(null);
                      setDraft(null);
                    }}
                  />
                ) : null}
                <Button
                  label={gt("Save memory")}
                  size="compact"
                  tone="primary"
                  loading={isSaving}
                  disabled={!canEdit || !isDirty || !withinLimit}
                  onPress={() => void handleSave()}
                />
              </View>
            </View>
          </>
        )}
      </View>
    </SettingsSection>
  );
}

export function ProjectMemorySettings(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
}) {
  const gt = useGT();
  if (!props.connected) {
    return (
      <SettingsSection title={gt("Project memory")}>
        <View className="px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {gt("Connect this machine to view and edit project memory.")}
          </Text>
        </View>
      </SettingsSection>
    );
  }
  return (
    <ProjectMemoryConnectedEditor environmentId={props.environmentId} projectId={props.projectId} />
  );
}
