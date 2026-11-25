import { useNavigate } from "@tanstack/react-router";
import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  PROJECT_THREAD_BOARD_COLUMNS,
  type ProjectThreadBoardColumn,
} from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { msg, T, useMessages, Var } from "gt-react";
import { FolderIcon, ListTodoIcon } from "lucide-react";

import { isElectron } from "~/env";
import { useAcknowledgeThreadWoke } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironment, useEnvironments } from "~/state/environments";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { ProjectViewTabs } from "./CoordinatorHeaderTabs";
import { sinceAwayDigestCount } from "./sinceAwayDigest.logic";
import { useProjectThreadBoard } from "./useProjectThreadBoard";

const COLUMN_PRESENTATION: Record<
  ProjectThreadBoardColumn,
  { readonly label: string; readonly dotClass: string }
> = {
  review: { label: msg("Ready for review"), dotClass: "bg-emerald-500 dark:bg-emerald-300/90" },
  waiting: { label: msg("Waiting on you"), dotClass: "bg-amber-500 dark:bg-amber-300/90" },
  working: { label: msg("Working"), dotClass: "bg-sky-500 dark:bg-sky-300/80" },
  idle: { label: msg("Idle"), dotClass: "bg-muted-foreground" },
  done: { label: msg("Done"), dotClass: "bg-border" },
};

const SINCE_AWAY_LABEL = msg("Since you were away");

const DIGEST_GROUP_PRESENTATION = [
  { key: "needsYou", label: msg("Needs you"), dotClass: "bg-amber-500 dark:bg-amber-300/90" },
  { key: "failed", label: msg("Failed"), dotClass: "bg-red-500 dark:bg-red-300/90" },
  { key: "finished", label: msg("Finished"), dotClass: "bg-emerald-500 dark:bg-emerald-300/90" },
] as const;

// Says why a card waits, in the stock status words: approval, input, or a failure.
function WaitingReason({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const m = useMessages();
  const status = resolveThreadStatusPill({ thread });
  return status ? <span className={status.colorClass}>{m(status.label)}</span> : null;
}

function ProjectThreadBoardContent({
  columns,
  openCount,
  digest,
  onOpenThread,
  emptyTitle,
  emptyDescription,
  className,
}: {
  readonly columns: Record<ProjectThreadBoardColumn, ReadonlyArray<EnvironmentThreadShell>>;
  readonly openCount: number;
  readonly digest: ReturnType<typeof useProjectThreadBoard>["digest"];
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly emptyTitle: React.ReactNode;
  readonly emptyDescription: React.ReactNode;
  readonly className?: string;
}) {
  const m = useMessages();
  const markThreadVisited = useAcknowledgeThreadWoke();

  if (openCount === 0 && columns.done.length === 0) {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTodoIcon />
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const hasDigest = sinceAwayDigestCount(digest) > 0;
  const markableThreads = [...digest.failed, ...digest.finished];
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {hasDigest ? (
        <section
          aria-label={m(SINCE_AWAY_LABEL)}
          className="mx-4 mt-3 flex shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">{m(SINCE_AWAY_LABEL)}</h2>
            {markableThreads.length > 0 ? (
              <Button
                variant="ghost-muted"
                size="xs"
                onClick={() => {
                  // The server's own updatedAt, like the command palette, so client clock skew can't leave a thread unseen.
                  for (const thread of markableThreads) {
                    markThreadVisited(
                      scopeThreadRef(thread.environmentId, thread.id),
                      thread.updatedAt,
                    );
                  }
                }}
              >
                <T>Mark all seen</T>
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            {DIGEST_GROUP_PRESENTATION.map(({ key, label, dotClass }) => {
              const threads = digest[key];
              if (threads.length === 0) return null;
              return (
                <div key={key} className="flex flex-wrap items-center gap-1.5">
                  <span className="flex shrink-0 items-center gap-1.5 pr-1 text-xs font-medium text-muted-foreground">
                    <span aria-hidden className={cn("size-2 rounded-full", dotClass)} />
                    {m(label)}
                    <span className="tabular-nums">{threads.length}</span>
                  </span>
                  {threads.map((thread) => (
                    <button
                      key={`${thread.environmentId}:${thread.id}`}
                      type="button"
                      onClick={() => onOpenThread(thread)}
                      className="max-w-56 cursor-pointer truncate rounded-md border bg-card px-2 py-0.5 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                    >
                      {thread.title}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {PROJECT_THREAD_BOARD_COLUMNS.map((column) => (
          <section
            key={column}
            aria-label={m(COLUMN_PRESENTATION[column].label)}
            className="flex min-h-0 min-w-48 flex-1 basis-0 flex-col"
          >
            <h2 className="mb-2 flex shrink-0 items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
              <span
                aria-hidden
                className={cn("size-2 rounded-full", COLUMN_PRESENTATION[column].dotClass)}
              />
              {m(COLUMN_PRESENTATION[column].label)}
              <span className="tabular-nums">{columns[column].length}</span>
            </h2>
            <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
              {columns[column].map((thread) => (
                <li key={`${thread.environmentId}:${thread.id}`}>
                  <button
                    type="button"
                    onClick={() => onOpenThread(thread)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
                      column === "done" && "text-muted-foreground",
                    )}
                  >
                    <span className="truncate text-sm">{thread.title}</span>
                    <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      {formatRelativeTimeLabel(thread.updatedAt)}
                      {column === "waiting" ? <WaitingReason thread={thread} /> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export function ProjectThreadsView({ projectKey }: { readonly projectKey: string }) {
  const navigate = useNavigate();
  const { isReady } = useEnvironments();
  const { group, columns, openCount, digest } = useProjectThreadBoard(projectKey);

  // From the board, a thread opens beside its project's coordinator when there is one.
  const openThread = (thread: EnvironmentThreadShell) => {
    const settings = readEnvironment(thread.environmentId)?.serverConfig?.settings;
    const coordinatorId = coordinatorThreadIdOf(settings, thread.projectId);
    if (coordinatorId === null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: thread.environmentId, threadId: thread.id },
      });
      return;
    }
    useRightPanelStore
      .getState()
      .openThread(scopeThreadRef(thread.environmentId, coordinatorId), thread.id, "thread");
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: coordinatorId },
    });
  };

  let body: React.ReactNode;
  if (group === null) {
    body = isReady ? (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderIcon />
          </EmptyMedia>
          <EmptyTitle>
            <T>Project not found</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>This project could not be found in your connected environments.</T>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <T>Loading project…</T>
      </div>
    );
  } else {
    body = (
      <ProjectThreadBoardContent
        columns={columns}
        openCount={openCount}
        digest={digest}
        onOpenThread={openThread}
        emptyTitle={<T>No threads yet</T>}
        emptyDescription={
          <T>
            Threads you or the coordinator start in <Var>{group.displayName}</Var> show up here by
            state.
          </T>
        }
      />
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-sm font-medium text-foreground">
              <T>Threads</T>
            </h1>
          </div>
          <ProjectViewTabs projectKey={projectKey} active="threads" />
        </WorkspacePageHeader>
        {body}
      </div>
    </SidebarInset>
  );
}
