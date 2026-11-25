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
import { Fragment } from "react";

import { useAcknowledgeThreadWoke } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironment, useEnvironments } from "~/state/environments";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ThreadStatusDot } from "../ThreadStatusDot";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { ProjectViewHeader } from "./ProjectViewHeader";
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

const DIGEST_GROUP_PRESENTATION = [
  {
    key: "needsYou",
    countLabel: msg("{count, plural, one {{count} needs you} other {{count} need you}}"),
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
  },
  {
    key: "failed",
    countLabel: msg("{count, plural, one {{count} failed} other {{count} failed}}"),
    dotClass: "bg-red-500 dark:bg-red-300/90",
  },
  {
    key: "finished",
    countLabel: msg("{count, plural, one {{count} finished} other {{count} finished}}"),
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
  },
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

  const digestGroups = DIGEST_GROUP_PRESENTATION.filter(({ key }) => digest[key].length > 0);
  // The digest's copies carry this client's last visit, so their status dot agrees with the counts.
  const unseenThreads = new Map(
    digestGroups
      .flatMap(({ key }) => digest[key])
      .map((thread) => [`${thread.environmentId}:${thread.id}`, thread]),
  );
  const markableThreads = [...digest.failed, ...digest.finished];
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {digestGroups.length > 0 ? (
        <div className="mx-4 mt-3 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs font-medium text-muted-foreground">
          <span>
            <T>Since you were away:</T>
          </span>
          {digestGroups.map(({ key, countLabel, dotClass }, index) => (
            <Fragment key={key}>
              {index > 0 ? <span aria-hidden>·</span> : null}
              <span className="flex items-center gap-1.5 tabular-nums">
                <span aria-hidden className={cn("size-2 rounded-full", dotClass)} />
                {m(countLabel, { count: digest[key].length })}
              </span>
            </Fragment>
          ))}
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
              {columns[column].map((thread) => {
                const unseenThread = unseenThreads.get(`${thread.environmentId}:${thread.id}`);
                return (
                  <li key={`${thread.environmentId}:${thread.id}`}>
                    <button
                      type="button"
                      onClick={() => onOpenThread(thread)}
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
                        column === "done" && "text-muted-foreground",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {unseenThread ? <ThreadStatusDot thread={unseenThread} /> : null}
                        <span className="truncate text-sm">{thread.title}</span>
                      </span>
                      <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        {formatRelativeTimeLabel(thread.updatedAt)}
                        {column === "waiting" ? <WaitingReason thread={thread} /> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
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
        <ProjectViewHeader projectKey={projectKey} group={group} view="threads" />
        {body}
      </div>
    </SidebarInset>
  );
}
