import { useNavigate } from "@tanstack/react-router";
import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  PROJECT_THREAD_BOARD_COLUMNS,
  type ProjectThreadBoardColumn,
} from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { FolderIcon, ListTodoIcon } from "lucide-react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironment, useEnvironments } from "~/state/environments";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { ProjectViewTabs } from "./CoordinatorHeaderTabs";
import { useProjectThreadBoard } from "./useProjectThreadBoard";

const COLUMN_PRESENTATION: Record<
  ProjectThreadBoardColumn,
  { readonly label: string; readonly dotClass: string }
> = {
  review: { label: "Ready for review", dotClass: "bg-emerald-500 dark:bg-emerald-300/90" },
  waiting: { label: "Waiting on you", dotClass: "bg-amber-500 dark:bg-amber-300/90" },
  working: { label: "Working", dotClass: "bg-sky-500 dark:bg-sky-300/80" },
  idle: { label: "Idle", dotClass: "bg-muted-foreground" },
  done: { label: "Done", dotClass: "bg-border" },
};

export function ProjectThreadsView({ projectKey }: { readonly projectKey: string }) {
  const navigate = useNavigate();
  const { isReady } = useEnvironments();
  const { group, columns, openCount } = useProjectThreadBoard(projectKey);

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
      .openSideChat(scopeThreadRef(thread.environmentId, coordinatorId), thread.id, "thread");
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
          <EmptyTitle>Project not found</EmptyTitle>
          <EmptyDescription>
            This project could not be found in your connected environments.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading project…
      </div>
    );
  } else if (openCount === 0 && columns.done.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTodoIcon />
          </EmptyMedia>
          <EmptyTitle>No threads yet</EmptyTitle>
          <EmptyDescription>
            Threads you or the coordinator start in {group.displayName} show up here by state.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {PROJECT_THREAD_BOARD_COLUMNS.map((column) => (
          <section
            key={column}
            aria-label={COLUMN_PRESENTATION[column].label}
            className="flex min-h-0 min-w-48 flex-1 basis-0 flex-col"
          >
            <h2 className="mb-2 flex shrink-0 items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
              <span
                aria-hidden
                className={cn("size-2 rounded-full", COLUMN_PRESENTATION[column].dotClass)}
              />
              {COLUMN_PRESENTATION[column].label}
              <span className="tabular-nums">{columns[column].length}</span>
            </h2>
            <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
              {columns[column].map((thread) => (
                <li key={`${thread.environmentId}:${thread.id}`}>
                  <button
                    type="button"
                    onClick={() => openThread(thread)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
                      column === "done" && "text-muted-foreground",
                    )}
                  >
                    <span className="truncate text-sm">{thread.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTimeLabel(thread.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-sm font-medium text-foreground">Threads</h1>
          </div>
          <ProjectViewTabs projectKey={projectKey} active="threads" />
        </WorkspacePageHeader>
        {body}
      </div>
    </SidebarInset>
  );
}
