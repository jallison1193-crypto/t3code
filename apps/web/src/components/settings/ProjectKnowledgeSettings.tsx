import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  classifyKnowledgeFile,
  formatMemoryByteSize,
  formatProjectMemoryError,
  knowledgeNameSet,
  utf8ByteLength,
  validateKnowledgeContentBeforeUpload,
  WEB_KNOWLEDGE_FILE_INPUT_ACCEPT,
} from "@t3tools/client-runtime/project-memory";
import {
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_FILES,
  type EnvironmentId,
  type ProjectId,
  type ProjectKnowledgeFileSummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { FileTextIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { extractPdfTextAsMarkdown } from "./projectKnowledgePdf";
import { SettingsRow } from "./settingsLayout";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";

function formatUpdatedTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function KnowledgeFilePreviewDialog({
  environmentId,
  projectId,
  file,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly file: ProjectKnowledgeFileSummary | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        {file !== null ? (
          <KnowledgeFilePreviewBody
            environmentId={environmentId}
            projectId={projectId}
            file={file}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function KnowledgeFilePreviewBody({
  environmentId,
  projectId,
  file,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly file: ProjectKnowledgeFileSummary;
}) {
  const gt = useGT();
  const detailAtom = projectEnvironment.knowledgeGet({
    environmentId,
    input: { projectId, name: file.name },
  });
  const detailResult = useAtomValue(detailAtom);
  const refreshDetail = useAtomRefresh(detailAtom);
  const detail = AsyncResult.getOrElse(detailResult, () => null);
  const failure = AsyncResult.isFailure(detailResult) ? detailResult.cause : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{file.name}</DialogTitle>
        <DialogDescription>
          {gt("{size} · Updated {updated}", {
            size: formatMemoryByteSize(detail?.sizeBytes ?? file.sizeBytes),
            updated: formatUpdatedTimestamp(detail?.updatedAt ?? file.updatedAt),
          })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {AsyncResult.isInitial(detailResult) ? (
          <p className="text-sm text-muted-foreground">{gt("Loading file contents...")}</p>
        ) : failure !== null ? (
          <Alert variant="error">
            <AlertDescription>
              {formatProjectMemoryError(failure, gt("Could not load knowledge file."))}
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" type="button" onClick={() => refreshDetail()}>
                {gt("Retry")}
              </Button>
            </AlertAction>
          </Alert>
        ) : detail !== null ? (
          <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground select-text">
            {detail.content}
          </pre>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare">
        <DialogClose render={<Button variant="outline" type="button" />}>{gt("Close")}</DialogClose>
      </DialogFooter>
    </>
  );
}

function ProjectKnowledgeManager({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const setting = searchableSetting("project-knowledge");
  const listAtom = projectEnvironment.knowledgeList({
    environmentId,
    input: { projectId },
  });
  const listResult = useAtomValue(listAtom);
  const refreshList = useAtomRefresh(listAtom);
  const canAdd = useAtomValue(projectEnvironment.knowledgeAdd.permissionAtom(environmentId));
  const canDelete = useAtomValue(projectEnvironment.knowledgeDelete.permissionAtom(environmentId));
  const addKnowledge = useAtomCommand(projectEnvironment.knowledgeAdd, { reportFailure: false });
  const deleteKnowledge = useAtomCommand(projectEnvironment.knowledgeDelete, {
    reportFailure: false,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<{
    readonly targetKey: string;
    readonly messages: ReadonlyArray<string>;
  } | null>(null);
  const [previewFile, setPreviewFile] = useState<ProjectKnowledgeFileSummary | null>(null);
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const targetKey = `${environmentId}:${projectId}`;
  const listData = AsyncResult.getOrElse(listResult, () => null);
  const files = listData?.files ?? [];
  const isInitialLoading = AsyncResult.isInitial(listResult);
  const listFailure = AsyncResult.isFailure(listResult) ? listResult.cause : null;
  const visibleErrors = [
    ...new Set(
      uploadErrors !== null && uploadErrors.targetKey === targetKey ? uploadErrors.messages : [],
    ),
  ];

  const formatValidationFailure = (
    fileName: string,
    reason:
      | "empty"
      | "too_long"
      | "invalid_characters"
      | "reserved_name"
      | "too_large"
      | "max_files_exceeded",
  ): string => {
    switch (reason) {
      case "too_large":
        return gt("{name} exceeds the {limit} file size limit.", {
          name: fileName,
          limit: formatMemoryByteSize(PROJECT_KNOWLEDGE_FILE_MAX_BYTES),
        });
      case "max_files_exceeded":
        return gt("{name} was skipped because the {max} knowledge file limit was reached.", {
          name: fileName,
          max: PROJECT_KNOWLEDGE_MAX_FILES,
        });
      default:
        return gt("{name} has an invalid filename.", { name: fileName });
    }
  };

  const handleFiles = async (selectedFiles: ReadonlyArray<File>) => {
    if (selectedFiles.length === 0 || !canAdd || isUploading) return;
    setIsUploading(true);
    setDeleteError(null);
    const errors: string[] = [];
    const trackedNames = knowledgeNameSet(files);

    for (const file of selectedFiles) {
      const classification = classifyKnowledgeFile({
        name: file.name,
        mimeType: file.type,
        allowPdf: true,
      });
      if (classification.kind === "unsupported") {
        errors.push(
          gt("{name} is not a supported text, code, or PDF file.", {
            name: file.name || gt("Selected file"),
          }),
        );
        continue;
      }

      if (classification.kind === "text" && file.size > PROJECT_KNOWLEDGE_FILE_MAX_BYTES) {
        errors.push(
          gt("{name} exceeds the {limit} file size limit.", {
            name: file.name,
            limit: formatMemoryByteSize(PROJECT_KNOWLEDGE_FILE_MAX_BYTES),
          }),
        );
        continue;
      }

      let content: string;
      try {
        content =
          classification.kind === "pdf" ? await extractPdfTextAsMarkdown(file) : await file.text();
      } catch (cause) {
        const detail =
          cause instanceof Error && cause.message ? cause.message : gt("Could not read file.");
        errors.push(`${file.name}: ${detail}`);
        continue;
      }

      if (
        classification.kind === "text" &&
        utf8ByteLength(content) > PROJECT_KNOWLEDGE_FILE_MAX_BYTES
      ) {
        errors.push(
          gt("{name} exceeds the {limit} file size limit.", {
            name: file.name,
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
        errors.push(formatValidationFailure(classification.targetName, check.reason));
        continue;
      }

      const result = await addKnowledge({
        environmentId,
        input: {
          projectId,
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

  const confirmDelete = async () => {
    if (confirmDeleteName === null || !canDelete || isDeleting) return;
    const targetName = confirmDeleteName;
    setIsDeleting(true);
    setDeleteError(null);
    const result = await deleteKnowledge({
      environmentId,
      input: { projectId, name: targetName },
    });
    setIsDeleting(false);
    if (result._tag === "Failure") {
      setDeleteError(
        formatProjectMemoryError(
          result.cause,
          gt("Failed to delete {name}.", { name: targetName }),
        ),
      );
      return;
    }
    if (previewFile?.name === targetName) {
      setPreviewFile(null);
    }
    setConfirmDeleteName(null);
  };

  return (
    <SettingsRow
      id={setting.id}
      title={setting.title}
      description={gt(
        "Reference documents available to agents in this project. Upload Markdown, text, JSON, CSV, code files, or PDFs (converted to Markdown).",
      )}
      control={
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={WEB_KNOWLEDGE_FILE_INPUT_ACCEPT}
            aria-label={gt("Choose knowledge files")}
            className="hidden"
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              event.target.value = "";
              void handleFiles(selected);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={!canAdd || isUploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon className="size-3.5" />
            {isUploading ? gt("Uploading...") : gt("Add files")}
          </Button>
        </div>
      }
    >
      <div
        data-slot="knowledge-dropzone-area"
        className={cn(
          "mt-3 max-w-2xl space-y-2.5 pb-3.5 transition-colors",
          isDragging && "rounded-lg bg-accent/40 ring-2 ring-primary/40",
        )}
        onDragEnter={(event) => {
          if (!canAdd) return;
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => {
          if (!canAdd) return;
          event.preventDefault();
          if (!isDragging) setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (!canAdd) return;
          const dropped = Array.from(event.dataTransfer.files ?? []);
          void handleFiles(dropped);
        }}
      >
        {!canAdd ? (
          <p className="text-xs text-muted-foreground">
            {gt("This connection does not have permission to upload knowledge files.")}
          </p>
        ) : null}

        {visibleErrors.length > 0 ? (
          <Alert variant="error">
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {visibleErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="ghost" type="button" onClick={() => setUploadErrors(null)}>
                {gt("Dismiss")}
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {deleteError !== null ? (
          <Alert variant="error">
            <AlertDescription>{deleteError}</AlertDescription>
          </Alert>
        ) : null}

        {isInitialLoading ? (
          <p className="text-xs text-muted-foreground">{gt("Loading knowledge files...")}</p>
        ) : listFailure !== null ? (
          <Alert variant="error">
            <AlertDescription>
              {formatProjectMemoryError(listFailure, gt("Could not load knowledge files."))}
            </AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" type="button" onClick={() => refreshList()}>
                {gt("Retry")}
              </Button>
            </AlertAction>
          </Alert>
        ) : files.length === 0 ? (
          <div
            data-slot="knowledge-dropzone"
            className="rounded-lg border border-dashed px-4 py-5 text-center text-xs text-muted-foreground"
          >
            {gt("No knowledge files yet. Drag and drop files here or click Add files to upload.")}
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="divide-y rounded-lg border bg-card">
              {files.map((file) => (
                <div key={file.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none hover:underline focus-visible:underline"
                    onClick={() => setPreviewFile(file)}
                  >
                    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-medium text-foreground">
                        {file.name}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        {gt("{size} · Updated {updated}", {
                          size: formatMemoryByteSize(file.sizeBytes),
                          updated: formatUpdatedTimestamp(file.updatedAt),
                        })}
                      </p>
                    </div>
                  </button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    aria-label={gt("Delete {name}", { name: file.name })}
                    disabled={!canDelete || isDeleting}
                    onClick={() => {
                      setDeleteError(null);
                      setConfirmDeleteName(file.name);
                    }}
                  >
                    <Trash2Icon className="size-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-2xs text-muted-foreground">
              {gt("{count} of {max} files · Drag and drop files here to add or overwrite", {
                count: files.length,
                max: PROJECT_KNOWLEDGE_MAX_FILES,
              })}
            </p>
          </div>
        )}
      </div>

      <KnowledgeFilePreviewDialog
        environmentId={environmentId}
        projectId={projectId}
        file={previewFile}
        onOpenChange={(open) => {
          if (!open) setPreviewFile(null);
        }}
      />

      <Dialog
        open={confirmDeleteName !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setConfirmDeleteName(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{gt("Delete knowledge file")}</DialogTitle>
            <DialogDescription>
              {confirmDeleteName !== null
                ? gt("Remove {name} from this project's knowledge files?", {
                    name: confirmDeleteName,
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={isDeleting}
              onClick={() => setConfirmDeleteName(null)}
            >
              {gt("Cancel")}
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? gt("Deleting...") : gt("Delete")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsRow>
  );
}

export function ProjectKnowledgeSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const scopeContext = useOptionalSettingsScope();
  if (scopeContext === null) return null;
  if (scopeContext.scope.kind !== "project" && scopeContext.scope.kind !== "checkout") return null;
  if (scopeContext.scope.members.length !== 1) return null;

  const target =
    scopeContext.targets.length === 1 && scopeContext.targets[0]?.projectId != null
      ? scopeContext.targets[0]
      : null;
  if (target === null || target.projectId === null) {
    const setting = searchableSetting("project-knowledge");
    return (
      <SettingsRow
        id={setting.id}
        title={setting.title}
        description={gt("Reconnect the selected environment to view and manage knowledge files.")}
      />
    );
  }

  return (
    <ProjectKnowledgeManager environmentId={target.environmentId} projectId={target.projectId} />
  );
}
