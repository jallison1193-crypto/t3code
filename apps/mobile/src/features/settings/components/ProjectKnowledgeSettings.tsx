import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  classifyKnowledgeFile,
  formatMemoryByteSize,
  formatProjectMemoryError,
  knowledgeNameSet,
  utf8ByteLength,
  validateKnowledgeContentBeforeUpload,
} from "@t3tools/client-runtime/project-memory";
import {
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_FILES,
  type EnvironmentId,
  type ProjectId,
  type ProjectKnowledgeFileSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { beginForegroundHandoff } from "../../../lib/foreground-handoff";
import { projectEnvironment } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

async function readPickedAssetText(asset: DocumentPicker.DocumentPickerAsset): Promise<string> {
  if (asset.file && typeof asset.file.text === "function") {
    return await asset.file.text();
  }
  return await new File(asset.uri).text();
}

function formatUpdatedTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function KnowledgeFilePreviewModalBody(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly file: ProjectKnowledgeFileSummary;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const detailAtom = projectEnvironment.knowledgeGet({
    environmentId: props.environmentId,
    input: { projectId: props.projectId, name: props.file.name },
  });
  const detailResult = useAtomValue(detailAtom);
  const refreshDetail = useAtomRefresh(detailAtom);
  const detail = AsyncResult.getOrElse(detailResult, () => null);
  const failure = AsyncResult.isFailure(detailResult) ? detailResult.cause : null;

  return (
    <SafeAreaView className="flex-1 bg-screen">
      <View className="flex-row items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-medium text-base text-foreground" numberOfLines={1}>
            {props.file.name}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {gt("{size} · Updated {updated}", {
              size: formatMemoryByteSize(detail?.sizeBytes ?? props.file.sizeBytes),
              updated: formatUpdatedTimestamp(detail?.updatedAt ?? props.file.updatedAt),
            })}
          </Text>
        </View>
        <Button label={gt("Close")} size="compact" tone="secondary" onPress={props.onClose} />
      </View>
      <ScrollView className="flex-1 p-4">
        {AsyncResult.isInitial(detailResult) ? (
          <View className="flex-row items-center gap-2 py-4">
            <AppActivityIndicator />
            <Text className="text-sm text-foreground-muted">{gt("Loading file contents...")}</Text>
          </View>
        ) : failure !== null ? (
          <View className="gap-2">
            <Text className="text-sm text-danger">
              {formatProjectMemoryError(failure, gt("Could not load knowledge file."))}
            </Text>
            <Button
              label={gt("Retry")}
              size="compact"
              tone="secondary"
              onPress={() => refreshDetail()}
            />
          </View>
        ) : detail !== null ? (
          <Text className="font-mono text-xs leading-relaxed text-foreground" selectable>
            {detail.content}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ProjectKnowledgeConnectedManager(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const listAtom = projectEnvironment.knowledgeList({
    environmentId: props.environmentId,
    input: { projectId: props.projectId },
  });
  const listResult = useAtomValue(listAtom);
  const refreshList = useAtomRefresh(listAtom);
  const canAdd = useAtomValue(projectEnvironment.knowledgeAdd.permissionAtom(props.environmentId));
  const canDelete = useAtomValue(
    projectEnvironment.knowledgeDelete.permissionAtom(props.environmentId),
  );
  const addKnowledge = useAtomCommand(projectEnvironment.knowledgeAdd, { reportFailure: false });
  const deleteKnowledge = useAtomCommand(projectEnvironment.knowledgeDelete, {
    reportFailure: false,
  });

  const [isUploading, setIsUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<{
    readonly targetKey: string;
    readonly messages: ReadonlyArray<string>;
  } | null>(null);
  const [previewFile, setPreviewFile] = useState<ProjectKnowledgeFileSummary | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const targetKey = `${props.environmentId}:${props.projectId}`;
  const listData = AsyncResult.getOrElse(listResult, () => null);
  const files = listData?.files ?? [];
  const isInitialLoading = AsyncResult.isInitial(listResult);
  const listFailure = AsyncResult.isFailure(listResult) ? listResult.cause : null;
  const visibleErrors = [
    ...new Set(
      uploadErrors !== null && uploadErrors.targetKey === targetKey ? uploadErrors.messages : [],
    ),
  ];

  const handlePickFiles = async () => {
    if (!canAdd || isUploading) return;
    const endHandoff = beginForegroundHandoff();
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
    } catch (cause) {
      endHandoff();
      setUploadErrors({
        targetKey,
        messages: [cause instanceof Error ? cause.message : gt("Could not open the file picker.")],
      });
      return;
    }
    endHandoff();
    if (picked.canceled || picked.assets.length === 0) return;

    setIsUploading(true);
    setDeleteError(null);
    const errors: string[] = [];
    const trackedNames = knowledgeNameSet(files);

    for (const asset of picked.assets) {
      const displayName = asset.name.trim().length > 0 ? asset.name : "file";
      const classification = classifyKnowledgeFile({
        name: displayName,
        mimeType: asset.mimeType,
        allowPdf: false,
      });
      if (classification.kind === "unsupported") {
        errors.push(
          classification.reason === "pdf-unsupported"
            ? gt(
                "{name}: PDF text extraction is only available on web. Upload Markdown or text files on mobile.",
                { name: displayName },
              )
            : gt("{name} is not a supported text or code file.", { name: displayName }),
        );
        continue;
      }

      if (typeof asset.size === "number" && asset.size > PROJECT_KNOWLEDGE_FILE_MAX_BYTES) {
        errors.push(
          gt("{name} exceeds the {limit} file size limit.", {
            name: displayName,
            limit: formatMemoryByteSize(PROJECT_KNOWLEDGE_FILE_MAX_BYTES),
          }),
        );
        continue;
      }

      let content: string;
      try {
        content = await readPickedAssetText(asset);
      } catch (cause) {
        errors.push(
          `${displayName}: ${cause instanceof Error && cause.message ? cause.message : gt("Could not read file.")}`,
        );
        continue;
      }

      if (utf8ByteLength(content) > PROJECT_KNOWLEDGE_FILE_MAX_BYTES) {
        errors.push(
          gt("{name} exceeds the {limit} file size limit.", {
            name: displayName,
            limit: formatMemoryByteSize(PROJECT_KNOWLEDGE_FILE_MAX_BYTES),
          }),
        );
        continue;
      }

      const check = validateKnowledgeContentBeforeUpload({
        targetName: classification.targetName,
        content,
        existingNames: trackedNames,
      });
      if (!check.ok) {
        errors.push(
          check.reason === "max_files_exceeded"
            ? gt("{name} was skipped because the {max} knowledge file limit was reached.", {
                name: classification.targetName,
                max: PROJECT_KNOWLEDGE_MAX_FILES,
              })
            : gt("{name} has an invalid filename.", { name: classification.targetName }),
        );
        continue;
      }

      const result = await addKnowledge({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          name: check.name,
          content,
        },
      });
      if (result._tag === "Failure") {
        errors.push(
          formatProjectMemoryError(
            result.cause,
            gt("Failed to upload {name}.", { name: check.name }),
          ),
        );
        continue;
      }
      trackedNames.add(check.name);
    }

    setUploadErrors(errors.length > 0 ? { targetKey, messages: errors } : null);
    setIsUploading(false);
  };

  const requestDelete = (fileName: string) => {
    if (!canDelete || deletingName !== null) return;
    Dialog.confirm({
      title: gt("Delete knowledge file"),
      message: gt("Remove {name} from this project's knowledge files?", { name: fileName }),
      confirmText: gt("Delete"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setDeletingName(fileName);
          setDeleteError(null);
          const result = await deleteKnowledge({
            environmentId: props.environmentId,
            input: { projectId: props.projectId, name: fileName },
          });
          setDeletingName(null);
          if (result._tag === "Failure") {
            setDeleteError(
              formatProjectMemoryError(
                result.cause,
                gt("Failed to delete {name}.", { name: fileName }),
              ),
            );
            return;
          }
          if (previewFile?.name === fileName) {
            setPreviewFile(null);
          }
        })();
      },
    });
  };

  return (
    <SettingsSection
      title={gt("Knowledge files")}
      footer={gt("Reference documents available to agents in this project.")}
      trailing={
        <Button
          label={isUploading ? gt("Uploading...") : gt("Add files")}
          icon="tray.and.arrow.up"
          size="compact"
          tone="secondary"
          loading={isUploading}
          disabled={!canAdd}
          onPress={() => void handlePickFiles()}
        />
      }
    >
      <View className="gap-2 px-4 py-3">
        {!canAdd ? (
          <Text className="text-xs text-foreground-muted">
            {gt("This connection does not have permission to upload knowledge files.")}
          </Text>
        ) : null}

        {visibleErrors.length > 0 ? (
          <View className="gap-1 rounded-xl border border-danger/30 bg-danger/10 p-3">
            {visibleErrors.map((message) => (
              <Text key={message} className="text-xs text-danger">
                {message}
              </Text>
            ))}
            <Button
              label={gt("Dismiss")}
              size="compact"
              tone="text"
              onPress={() => setUploadErrors(null)}
            />
          </View>
        ) : null}

        {deleteError !== null ? <Text className="text-xs text-danger">{deleteError}</Text> : null}

        {isInitialLoading ? (
          <View className="flex-row items-center gap-2 py-2">
            <AppActivityIndicator />
            <Text className="text-sm text-foreground-muted">
              {gt("Loading knowledge files...")}
            </Text>
          </View>
        ) : listFailure !== null ? (
          <View className="gap-2">
            <Text className="text-sm text-danger">
              {formatProjectMemoryError(listFailure, gt("Could not load knowledge files."))}
            </Text>
            <Button
              label={gt("Retry")}
              size="compact"
              tone="secondary"
              onPress={() => refreshList()}
            />
          </View>
        ) : files.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            {gt("No knowledge files yet. Tap Add files to upload Markdown, text, or code files.")}
          </Text>
        ) : (
          <View className="gap-1">
            {files.map((file, index) => (
              <View
                key={file.name}
                className={
                  index === 0
                    ? "flex-row items-center justify-between gap-2 py-2"
                    : "flex-row items-center justify-between gap-2 border-t border-border-subtle py-2"
                }
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={file.name}
                  className="min-w-0 flex-1 flex-row items-center gap-2.5"
                  onPress={() => setPreviewFile(file)}
                >
                  <SymbolView
                    name="doc.text"
                    size={18}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <View className="min-w-0 flex-1">
                    <Text className="font-mono text-sm text-foreground" numberOfLines={1}>
                      {file.name}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {gt("{size} · Updated {updated}", {
                        size: formatMemoryByteSize(file.sizeBytes),
                        updated: formatUpdatedTimestamp(file.updatedAt),
                      })}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("Delete {name}", { name: file.name })}
                  disabled={!canDelete || deletingName !== null}
                  className="p-2 active:opacity-70"
                  onPress={() => requestDelete(file.name)}
                >
                  <SymbolView
                    name="trash"
                    size={18}
                    tintColorClassName={
                      !canDelete || deletingName !== null
                        ? "accent-foreground-muted"
                        : "accent-danger"
                    }
                  />
                </Pressable>
              </View>
            ))}
            <Text className="pt-1 text-xs text-foreground-muted">
              {gt("{count} of {max} files", {
                count: files.length,
                max: PROJECT_KNOWLEDGE_MAX_FILES,
              })}
            </Text>
          </View>
        )}
      </View>

      <Modal
        visible={previewFile !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPreviewFile(null)}
      >
        {previewFile !== null ? (
          <KnowledgeFilePreviewModalBody
            environmentId={props.environmentId}
            projectId={props.projectId}
            file={previewFile}
            onClose={() => setPreviewFile(null)}
          />
        ) : null}
      </Modal>
    </SettingsSection>
  );
}

export function ProjectKnowledgeSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
}) {
  const gt = useGT();
  if (!props.connected) {
    return (
      <SettingsSection title={gt("Knowledge files")}>
        <View className="px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {gt("Connect this machine to view and manage knowledge files.")}
          </Text>
        </View>
      </SettingsSection>
    );
  }
  return (
    <ProjectKnowledgeConnectedManager
      environmentId={props.environmentId}
      projectId={props.projectId}
    />
  );
}
