import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_V2_WS_METHODS, type SidebarModeFilter as Mode } from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { T, useGT, Var } from "gt-react";
import { ArrowUpRightIcon, LibraryIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { HtmlRenderDialog } from "../chat/HtmlRenderDialog";
import { ProjectViewTabs } from "../projectHome/CoordinatorHeaderTabs";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { SidebarModeFilter } from "../sidebar/SidebarModeFilter";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  libraryEntryKey,
  libraryPageView,
  librarySources,
  loadLibraryPages,
  startLibrary,
  type HtmlLibraryEntry,
} from "./htmlLibraryPages";

const listHtmlLibrary = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:orchestration:html-library",
  tag: ORCHESTRATION_V2_WS_METHODS.listHtmlLibrary,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

function LibraryPreview({
  entry,
  close,
}: {
  readonly entry: HtmlLibraryEntry;
  readonly close: () => void;
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
  const connected = useConnectedEnvironmentIds();
  const read = useAtomQueryRunner(listHtmlLibrary, { reportFailure: false, reportDefect: false });
  const [initialPages] = useState(() => startLibrary(sources));
  const [pages, setPages] = useState(initialPages);
  const [pending, setPending] = useState(true);
  const [selected, setSelected] = useState<HtmlLibraryEntry | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const load = useStableCallback(async (current: typeof pages, signal: AbortSignal) => {
    setPending(true);
    const loaded = await loadLibraryPages(current, mode, async (environmentId, input) => {
      if (!connected.includes(environmentId)) throw new Error("Environment offline");
      const result = await read(
        { environmentId, input },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      );
      if (result._tag === "Failure") throw result.cause;
      return result.value;
    });
    if (signal.aborted) return;
    setPages(loaded);
    setPending(false);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening the library starts an RPC round, which is cancelled when the view closes
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load(initialPages, controller.signal);
    return () => controller.abort();
  }, [load, initialPages]);

  const view = libraryPageView(pages);
  const labels = new Map(environments.map(({ environmentId, label }) => [environmentId, label]));
  const request = (current: typeof pages) => {
    if (lifetime.current) void load(current, lifetime.current.signal);
  };
  const empty = view.entries.length === 0;
  const allUnavailable = pages.streams.length > 0 && pages.streams.every((s) => s.unavailable);
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
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => request(initialPages)}
          >
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
      {empty && allUnavailable && !pending ? null : empty ? (
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
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {view.entries.map((entry) => {
            const label = labels.get(entry.environmentId);
            const source = [entry.projectTitle, entry.threadTitle, label]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={libraryEntryKey(entry)} className="flex min-w-0 items-center">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-3 py-2 text-start hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
                  onClick={() => setSelected(entry)}
                >
                  <span className="w-full truncate text-sm font-medium">{entry.title}</span>
                  <span className="w-full truncate text-xs text-muted-foreground">{source}</span>
                </button>
                <div className="shrink-0 px-2">
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
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {view.hasMore && !(pending && empty) ? (
        <div className="mt-3">
          <Button variant="outline" size="sm" disabled={pending} onClick={() => request(pages)}>
            {pending ? <T>Loading…</T> : <T>Load more</T>}
          </Button>
        </div>
      ) : null}
      {selected ? <LibraryPreview entry={selected} close={() => setSelected(null)} /> : null}
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
  const mode = useClientSettings((settings) => settings.sidebarModeFilter);
  const settingsReady = useClientSettingsHydrated();
  const { environments, isReady } = useEnvironments();
  const connected = useConnectedEnvironmentIds();
  const sources = projectKey
    ? librarySources(group?.memberProjects ?? [])
    : environments
        .map(({ environmentId }) => ({ environmentId }))
        .sort((a, b) => a.environmentId.localeCompare(b.environmentId));
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
            <div className="mb-4">
              <SidebarModeFilter label={gt("Library mode filter")} />
            </div>
            {isReady && settingsReady ? (
              projectKey && !group ? (
                <p role="status" className="py-6 text-sm text-muted-foreground">
                  <T>Project not found</T>
                </p>
              ) : (
                <LibraryResults
                  key={JSON.stringify([
                    mode,
                    sources,
                    sources.map((s) => connected.includes(s.environmentId)),
                  ])}
                  sources={sources}
                  mode={mode}
                  environments={environments}
                />
              )
            ) : (
              <p role="status" className="py-6 text-sm text-muted-foreground">
                <T>Loading HTML pages…</T>
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
