import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcQueryAtomFamily,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ListHtmlLibraryInput,
  type OrchestrationV2ListLibraryFilesInput,
  type SidebarModeFilter as Mode,
} from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ArrowUpRightIcon,
  EllipsisIcon,
  LibraryIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { useComposerDraftStore } from "~/composerDraftStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { dispatchSnapShotComposerFocus } from "~/lib/desktopSnapShot";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { HtmlRenderDialog } from "../chat/HtmlRenderDialog";
import { ProjectViewTabs } from "../projectHome/CoordinatorHeaderTabs";
import { RelativeTime } from "../RelativeTime";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { SidebarModeFilter } from "../sidebar/SidebarModeFilter";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  askForChangesPrompt,
  htmlLibraryEntryOverrideChange,
  htmlLibraryPatchApplied,
  isValidLibraryEntryTitle,
  libraryEntryKey,
  libraryPageView,
  librarySources,
  loadLibraryPages,
  loadPinnedLibraryEntries,
  startLibrary,
  type HtmlLibraryEntry,
} from "./htmlLibraryPages";
import {
  libraryFileEntryKey,
  libraryFileOpenPath,
  libraryFilesView,
  libraryUrlWithView,
  libraryViewFromSearch,
  loadLibraryFiles,
  splitLibraryFilePath,
  startLibraryFiles,
  type LibraryFileEntry,
  type LibraryView,
} from "./libraryFiles.logic";

const listHtmlLibrary = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:orchestration:html-library",
  tag: ORCHESTRATION_V2_WS_METHODS.listHtmlLibrary,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

const listLibraryFiles = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:orchestration:library-files",
  tag: ORCHESTRATION_V2_WS_METHODS.listLibraryFiles,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

function LibraryPreview({
  entry,
  close,
  onAskForChanges,
}: {
  readonly entry: HtmlLibraryEntry;
  readonly close: () => void;
  readonly onAskForChanges: (entry: HtmlLibraryEntry) => void;
}) {
  const connected = useConnectedEnvironmentIds().includes(entry.environmentId);
  const asset = useLongLivedAssetUrl(connected ? entry.environmentId : null, {
    _tag: "attachment",
    attachmentId: entry.attachmentId,
    fileName: htmlRenderFileName(entry.title),
    mimeType: "text/html",
    disposition: "inline",
  });
  if (asset._tag === "Success") {
    return (
      <HtmlRenderDialog
        src={asset.url}
        htmlRender={entry}
        threadRef={scopeThreadRef(entry.environmentId, entry.threadId)}
        onClose={close}
        onAskForChanges={() => {
          close();
          onAskForChanges(entry);
        }}
      />
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogPopup>
        <DialogTitle>{entry.title}</DialogTitle>
        <p role="status" className="text-sm text-muted-foreground">
          {connected && asset._tag !== "Failure" ? (
            <T>Loading preview…</T>
          ) : (
            <T>Page unavailable</T>
          )}
        </p>
      </DialogPopup>
    </Dialog>
  );
}

function RenameLibraryEntryDialog({
  entry,
  busy,
  error,
  onClose,
  onSave,
}: {
  readonly entry: HtmlLibraryEntry;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: (title: string) => void;
}) {
  const gt = useGT();
  const inputId = useId();
  const [draftTitle, setDraftTitle] = useState(entry.title);
  const [validationError, setValidationError] = useState<string | null>(null);
  const shownError = validationError ?? error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (!isValidLibraryEntryTitle(draftTitle)) {
              setValidationError(gt("Page title must be a single line."));
              return;
            }
            onSave(draftTitle);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Rename page</T>
            </DialogTitle>
            <DialogDescription>
              <T>Leave blank to restore the original title.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-2">
              <Label htmlFor={inputId}>
                <T>Page title</T>
              </Label>
              <Input
                id={inputId}
                value={draftTitle}
                disabled={busy}
                autoFocus
                onChange={(event) => {
                  setDraftTitle(event.target.value);
                  setValidationError(null);
                }}
              />
            </div>
            {shownError ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {shownError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              <T>Cancel</T>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              <T>Save</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function LibraryEntryRow({
  entry,
  label,
  canEdit,
  busy,
  onSelect,
  onTogglePin,
  onRename,
  onAskForChanges,
}: {
  readonly entry: HtmlLibraryEntry;
  readonly label: string | undefined;
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onSelect: (entry: HtmlLibraryEntry) => void;
  readonly onTogglePin: (entry: HtmlLibraryEntry) => void;
  readonly onRename: (entry: HtmlLibraryEntry) => void;
  readonly onAskForChanges: (entry: HtmlLibraryEntry) => void;
}) {
  const gt = useGT();
  const source = [entry.projectTitle, entry.threadTitle, label].filter(Boolean).join(" · ");
  return (
    <li className="flex min-w-0 items-center">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 py-2 text-start hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
        onClick={() => onSelect(entry)}
      >
        <span className="w-full truncate text-sm font-medium">{entry.title}</span>
        <span className="w-full truncate text-xs text-muted-foreground">{source}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1 px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={gt("Open source thread")}
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId: entry.environmentId,
                      threadId: entry.threadId,
                    }}
                  />
                }
              />
            }
          >
            <ArrowUpRightIcon />
          </TooltipTrigger>
          <TooltipPopup>{gt("Open source thread")}</TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={gt("Page actions")} />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!canEdit || busy} onClick={() => onTogglePin(entry)}>
              {entry.pinned ? (
                <>
                  <PinOffIcon />
                  <T>Unpin</T>
                </>
              ) : (
                <>
                  <PinIcon />
                  <T>Pin</T>
                </>
              )}
            </MenuItem>
            <MenuItem disabled={!canEdit || busy} onClick={() => onRename(entry)}>
              <PencilIcon />
              <T>Rename</T>
            </MenuItem>
            <MenuItem onClick={() => onAskForChanges(entry)}>
              <MessageSquareIcon />
              <T>Ask for changes</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

function LibraryResults({
  sources,
  mode,
  environments,
}: {
  readonly sources: Parameters<typeof startLibrary>[0];
  readonly mode: Mode;
  readonly environments: ReturnType<typeof useEnvironments>["environments"];
}) {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const pinnedHeadingId = useId();
  const recentHeadingId = useId();
  const connected = useConnectedEnvironmentIds();
  const editable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const read = useAtomQueryRunner(listHtmlLibrary, { reportFailure: false, reportDefect: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [initialPages] = useState(() => startLibrary(sources));
  const [pages, setPages] = useState(initialPages);
  const [pinnedEntries, setPinnedEntries] = useState<readonly HtmlLibraryEntry[]>([]);
  const [pending, setPending] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<HtmlLibraryEntry | null>(null);
  const [renaming, setRenaming] = useState<HtmlLibraryEntry | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  const environmentsById = new Map(environments.map((env) => [env.environmentId, env]));
  const connectedSources = sources.filter((source) => connected.includes(source.environmentId));
  const entriesSignature = JSON.stringify(
    connectedSources.map(
      (source) =>
        environmentsById.get(source.environmentId)?.serverConfig?.settings.htmlLibraryEntries ??
        null,
    ),
  );

  const startRequest = () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    return controller.signal;
  };

  const readSource = useStableCallback(
    async (
      environmentId: EnvironmentId,
      input: OrchestrationV2ListHtmlLibraryInput,
      signal: AbortSignal,
    ) => {
      if (!connected.includes(environmentId)) throw new Error("Environment offline");
      const result = await read(
        { environmentId, input },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      if (result._tag === "Failure") throw result.cause;
      return result.value;
    },
  );

  const refresh = useStableCallback(async () => {
    const signal = startRequest();
    setPending(true);
    const [loadedPages, loadedPinned] = await Promise.all([
      loadLibraryPages(initialPages, mode, (environmentId, input) =>
        readSource(environmentId, input, signal),
      ),
      loadPinnedLibraryEntries(connectedSources, mode, (environmentId, input) =>
        readSource(environmentId, input, signal),
      ),
    ]);
    if (signal.aborted) return;
    setPages(loadedPages);
    setPinnedEntries(loadedPinned);
    setPending(false);
  });

  const loadMore = useStableCallback(async (current: typeof pages) => {
    const signal = startRequest();
    setPending(true);
    const loaded = await loadLibraryPages(current, mode, (environmentId, input) =>
      readSource(environmentId, input, signal),
    );
    if (signal.aborted) return;
    setPages(loaded);
    setPending(false);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening the library starts an RPC round, which is cancelled when the view closes
  useEffect(() => {
    void refresh();
    return () => activeRequest.current?.abort();
  }, [refresh]);

  const seenEntriesSignature = useRef(entriesSignature);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a pin or rename from another client arrives over the config stream
  useEffect(() => {
    if (seenEntriesSignature.current === entriesSignature) return;
    seenEntriesSignature.current = entriesSignature;
    void refresh();
  }, [entriesSignature, refresh]);

  const applyEntryChange = useStableCallback(
    async (
      entry: HtmlLibraryEntry,
      change: Parameters<typeof htmlLibraryEntryOverrideChange>[2],
    ): Promise<string | null> => {
      const stored = environmentsById.get(entry.environmentId)?.serverConfig?.settings
        .htmlLibraryEntries[entry.attachmentId];
      const nextOverride = htmlLibraryEntryOverrideChange(entry, stored, change);
      setMutating(true);
      const describeFailure = (cause: unknown) =>
        thrownErrorMessage(cause, m) ?? gt("An error occurred.");
      const submission = await settlePromise(async () => {
        const result = await updateSettings({
          environmentId: entry.environmentId,
          input: { patch: { htmlLibraryEntries: { [entry.attachmentId]: nextOverride } } },
        });
        if (result._tag === "Failure") return describeFailure(squashAtomCommandFailure(result));
        if (!htmlLibraryPatchApplied(result.value, entry.attachmentId, nextOverride)) {
          return gt("This server did not apply the library change.");
        }
        return null;
      });
      setMutating(false);
      const failure =
        submission._tag === "Failure"
          ? describeFailure(squashAtomCommandFailure(submission))
          : submission.value;
      if (failure === null) {
        setActionError(null);
        void refresh();
      }
      return failure;
    },
  );

  const handleTogglePin = useStableCallback(async (entry: HtmlLibraryEntry) => {
    const failure = await applyEntryChange(
      entry,
      entry.pinned ? { kind: "unpin" } : { kind: "pin", pinnedAt: new Date().toISOString() },
    );
    if (failure !== null) setActionError(failure);
  });

  const handleRenameSave = useStableCallback(async (entry: HtmlLibraryEntry, title: string) => {
    const failure = await applyEntryChange(entry, {
      kind: "rename",
      title: title.trim() === "" ? null : title,
    });
    if (failure === null) {
      setRenaming(null);
      setRenameError(null);
    } else {
      setRenameError(failure);
    }
  });

  const handleAskForChanges = useStableCallback((entry: HtmlLibraryEntry) => {
    const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
    const drafts = useComposerDraftStore.getState();
    const existing = drafts.getComposerDraft(threadRef)?.prompt ?? "";
    drafts.setPrompt(threadRef, askForChangesPrompt(existing, entry.title));
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: entry.environmentId, threadId: entry.threadId },
    }).then(() => {
      window.requestAnimationFrame(() => dispatchSnapShotComposerFocus());
    });
  });

  const view = libraryPageView(pages);
  const pinnedKeys = new Set(pinnedEntries.map(libraryEntryKey));
  const recentEntries = view.entries.filter(
    (entry) => !entry.pinned && !pinnedKeys.has(libraryEntryKey(entry)),
  );
  const labels = new Map(environments.map(({ environmentId, label }) => [environmentId, label]));
  const hasPinned = pinnedEntries.length > 0;
  const hasRecent = recentEntries.length > 0;
  const empty = !hasPinned && !hasRecent;
  const allUnavailable = pages.streams.length > 0 && pages.streams.every((s) => s.unavailable);
  const canEditEntry = (entry: HtmlLibraryEntry) =>
    connected.includes(entry.environmentId) && editable.has(entry.environmentId);

  return (
    <>
      {actionError ? (
        <p role="alert" className="mb-3 text-sm text-destructive-foreground">
          {actionError}
        </p>
      ) : null}
      {view.unavailable.length > 0 ? (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            <T>
              Library unavailable on{" "}
              <Var>{view.unavailable.map((id) => labels.get(id) ?? id).join(", ")}</Var>.
            </T>
          </span>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void refresh()}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
      {hasPinned ? (
        <section aria-labelledby={pinnedHeadingId} className="mb-6">
          <h2
            id={pinnedHeadingId}
            className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
          >
            <T>Pinned</T>
          </h2>
          <ul className="divide-y divide-border rounded-lg border bg-card">
            {pinnedEntries.map((entry) => (
              <LibraryEntryRow
                key={libraryEntryKey(entry)}
                entry={entry}
                label={labels.get(entry.environmentId)}
                canEdit={canEditEntry(entry)}
                busy={mutating}
                onSelect={setSelected}
                onTogglePin={(target) => void handleTogglePin(target)}
                onRename={(target) => {
                  setRenameError(null);
                  setRenaming(target);
                }}
                onAskForChanges={handleAskForChanges}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {empty && allUnavailable && !pending ? null : hasRecent ? (
        <section aria-labelledby={hasPinned ? recentHeadingId : undefined}>
          {hasPinned ? (
            <h2
              id={recentHeadingId}
              className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              <T>Recent</T>
            </h2>
          ) : null}
          <ul className="divide-y divide-border rounded-lg border bg-card">
            {recentEntries.map((entry) => (
              <LibraryEntryRow
                key={libraryEntryKey(entry)}
                entry={entry}
                label={labels.get(entry.environmentId)}
                canEdit={canEditEntry(entry)}
                busy={mutating}
                onSelect={setSelected}
                onTogglePin={(target) => void handleTogglePin(target)}
                onRename={(target) => {
                  setRenameError(null);
                  setRenaming(target);
                }}
                onAskForChanges={handleAskForChanges}
              />
            ))}
          </ul>
        </section>
      ) : empty ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          {pending ? (
            <T>Loading HTML pages…</T>
          ) : view.hasMore ? (
            <T>Keep searching to see more results.</T>
          ) : view.unavailable.length === 0 ? (
            <T>No HTML pages found.</T>
          ) : (
            <T>No HTML pages found in available environments.</T>
          )}
        </p>
      ) : view.hasMore && !pending ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          <T>Keep searching to see more results.</T>
        </p>
      ) : null}
      {view.hasMore && !(pending && empty) ? (
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void loadMore(pages)}
          >
            {pending ? <T>Loading…</T> : <T>Load more</T>}
          </Button>
        </div>
      ) : null}
      {selected ? (
        <LibraryPreview
          entry={selected}
          close={() => setSelected(null)}
          onAskForChanges={handleAskForChanges}
        />
      ) : null}
      {renaming ? (
        <RenameLibraryEntryDialog
          entry={renaming}
          busy={mutating}
          error={renameError}
          onClose={() => {
            setRenaming(null);
            setRenameError(null);
          }}
          onSave={(title) => void handleRenameSave(renaming, title)}
        />
      ) : null}
    </>
  );
}

function LibraryFileRow({
  entry,
  showProject,
  label,
  workspaceRoot,
  onOpenFile,
}: {
  readonly entry: LibraryFileEntry;
  readonly showProject: boolean;
  readonly label: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly onOpenFile: (entry: LibraryFileEntry, relativePath: string) => void;
}) {
  const gt = useGT();
  const { fileName, parentFolder } = splitLibraryFilePath(entry.path, workspaceRoot);
  const openPath = libraryFileOpenPath(entry, workspaceRoot);
  const source = [showProject ? entry.projectTitle : null, entry.threadTitle, label]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{fileName}</span>
          {parentFolder ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{parentFolder}</span>
          ) : null}
        </div>
        <span className="w-full truncate text-xs text-muted-foreground">
          {source ? `${source} · ` : null}
          <RelativeTime timestamp={entry.updatedAt} />
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {openPath !== null ? (
          <Button variant="outline" size="xs" onClick={() => onOpenFile(entry, openPath)}>
            <T>Open</T>
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={gt("Show thread")}
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId: entry.environmentId,
                      threadId: entry.threadId,
                    }}
                  />
                }
              />
            }
          >
            <ArrowUpRightIcon />
          </TooltipTrigger>
          <TooltipPopup>{gt("Show thread")}</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}

function LibraryFilesResults({
  sources,
  mode,
  environments,
  showProject,
}: {
  readonly sources: Parameters<typeof startLibraryFiles>[0];
  readonly mode: Mode;
  readonly environments: ReturnType<typeof useEnvironments>["environments"];
  readonly showProject: boolean;
}) {
  const navigate = useNavigate();
  const connected = useConnectedEnvironmentIds();
  const projects = useProjects();
  const threadShells = useQuietThreadShells();
  const read = useAtomQueryRunner(listLibraryFiles, { reportFailure: false, reportDefect: false });
  const [initialFiles] = useState(() => startLibraryFiles(sources));
  const [files, setFiles] = useState(initialFiles);
  const [pending, setPending] = useState(true);
  const activeRequest = useRef<AbortController | null>(null);

  const startRequest = () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    return controller.signal;
  };

  const readSource = useStableCallback(
    async (
      environmentId: EnvironmentId,
      input: OrchestrationV2ListLibraryFilesInput,
      signal: AbortSignal,
    ) => {
      if (!connected.includes(environmentId)) throw new Error("Environment offline");
      const result = await read(
        { environmentId, input },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      if (result._tag === "Failure") throw result.cause;
      return result.value;
    },
  );

  const refresh = useStableCallback(async () => {
    const signal = startRequest();
    setPending(true);
    const loaded = await loadLibraryFiles(initialFiles, mode, (environmentId, input) =>
      readSource(environmentId, input, signal),
    );
    if (signal.aborted) return;
    setFiles(loaded);
    setPending(false);
  });

  const loadMore = useStableCallback(async (current: typeof files) => {
    const signal = startRequest();
    setPending(true);
    const loaded = await loadLibraryFiles(current, mode, (environmentId, input) =>
      readSource(environmentId, input, signal),
    );
    if (signal.aborted) return;
    setFiles(loaded);
    setPending(false);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening the files view starts an RPC round, which is cancelled when the view closes
  useEffect(() => {
    void refresh();
    return () => activeRequest.current?.abort();
  }, [refresh]);

  const handleOpenFile = useStableCallback((entry: LibraryFileEntry, relativePath: string) => {
    const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
    useRightPanelStore.getState().openFile(threadRef, relativePath);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: entry.environmentId, threadId: entry.threadId },
    });
  });

  const projectWorkspaceByKey = new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.workspaceRoot,
    ]),
  );
  const threadWorktreeByKey = new Map(
    threadShells.flatMap((thread) =>
      thread.worktreePath
        ? [
            [
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
              thread.worktreePath,
            ] as const,
          ]
        : [],
    ),
  );
  const view = libraryFilesView(files);
  const labels = new Map(environments.map(({ environmentId, label }) => [environmentId, label]));
  const empty = view.entries.length === 0;
  const allUnavailable = files.streams.length > 0 && files.streams.every((s) => s.unavailable);

  return (
    <>
      {view.unavailable.length > 0 ? (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">
            <T>
              Library unavailable on{" "}
              <Var>{view.unavailable.map((id) => labels.get(id) ?? id).join(", ")}</Var>.
            </T>
          </span>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void refresh()}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
      {empty && allUnavailable && !pending ? null : !empty ? (
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {view.entries.map((entry) => {
            const workspaceRoot =
              threadWorktreeByKey.get(
                scopedThreadKey(scopeThreadRef(entry.environmentId, entry.threadId)),
              ) ??
              entry.workspaceRoot ??
              projectWorkspaceByKey.get(
                scopedProjectKey(scopeProjectRef(entry.environmentId, entry.projectId)),
              );
            return (
              <LibraryFileRow
                key={libraryFileEntryKey(entry)}
                entry={entry}
                showProject={showProject}
                label={labels.get(entry.environmentId)}
                workspaceRoot={workspaceRoot}
                onOpenFile={handleOpenFile}
              />
            );
          })}
        </ul>
      ) : (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          {pending ? (
            <T>Loading files…</T>
          ) : view.hasMore ? (
            <T>Keep searching to see more results.</T>
          ) : view.unavailable.length === 0 ? (
            <T>No files found.</T>
          ) : (
            <T>No files found in available environments.</T>
          )}
        </p>
      )}
      {!empty && view.hasMore && !pending ? (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          <T>Keep searching to see more results.</T>
        </p>
      ) : null}
      {view.hasMore && !(pending && empty) ? (
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void loadMore(files)}
          >
            {pending ? <T>Loading…</T> : <T>Load more</T>}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function HtmlLibraryContent({
  projectKey,
  group,
}: {
  readonly projectKey?: string;
  readonly group?: ReturnType<typeof useSettingsProjectGroups>[number];
}) {
  const gt = useGT();
  const location = useLocation();
  const navigate = useNavigate();
  const view = libraryViewFromSearch(location.searchStr);
  const mode = useClientSettings((settings) => settings.sidebarModeFilter);
  const settingsReady = useClientSettingsHydrated();
  const { environments, isReady } = useEnvironments();
  const connected = useConnectedEnvironmentIds();
  const sources = projectKey
    ? librarySources(group?.memberProjects ?? [])
    : environments
        .map(({ environmentId }) => ({ environmentId }))
        .sort((a, b) => a.environmentId.localeCompare(b.environmentId));
  const resultsKey = JSON.stringify([
    mode,
    sources,
    sources.map((s) => connected.includes(s.environmentId)),
  ]);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <LibraryIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-sm font-medium text-foreground">
              {group ? group.displayName : <T>HTML Library</T>}
            </h1>
          </div>
          {projectKey ? <ProjectViewTabs projectKey={projectKey} active="library" /> : null}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
          <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <ToggleGroup
                aria-label={gt("Library view")}
                variant="segmented"
                size="segmented"
                value={[view]}
                onValueChange={(next) => {
                  const target = next.find((value): value is LibraryView => value !== view);
                  if (!target) return;
                  void navigate({
                    href: libraryUrlWithView(
                      location.pathname,
                      location.searchStr,
                      location.hash,
                      target,
                    ),
                    replace: true,
                  });
                }}
              >
                <Toggle value="pages">
                  <T>Pages</T>
                </Toggle>
                <Toggle value="files">
                  <T>Files</T>
                </Toggle>
              </ToggleGroup>
              <SidebarModeFilter label={gt("Library mode filter")} />
            </div>
            {isReady && settingsReady ? (
              projectKey && !group ? (
                <p role="status" className="py-6 text-sm text-muted-foreground">
                  <T>Project not found</T>
                </p>
              ) : view === "files" ? (
                <LibraryFilesResults
                  key={resultsKey}
                  sources={sources}
                  mode={mode}
                  environments={environments}
                  showProject={!projectKey}
                />
              ) : (
                <LibraryResults
                  key={resultsKey}
                  sources={sources}
                  mode={mode}
                  environments={environments}
                />
              )
            ) : (
              <p role="status" className="py-6 text-sm text-muted-foreground">
                {view === "files" ? <T>Loading files…</T> : <T>Loading HTML pages…</T>}
              </p>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export function HtmlLibraryPage() {
  return <HtmlLibraryContent />;
}

export function ProjectLibraryPage({ projectKey }: { readonly projectKey: string }) {
  const group = useSettingsProjectGroups().find((group) => group.projectKey === projectKey);
  return <HtmlLibraryContent projectKey={projectKey} {...(group ? { group } : {})} />;
}
