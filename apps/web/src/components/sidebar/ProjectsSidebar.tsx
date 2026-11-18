import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  projectThreadBoardColumn,
  type ProjectThreadBoardColumn,
} from "@t3tools/client-runtime/project-thread-board";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, FolderPlusIcon, SearchIcon, SquarePenIcon } from "lucide-react";
import { useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { useShownThreadRouteTarget } from "~/hooks/useShownThreadRouteTarget";
import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar,
} from "../ui/sidebar";
import {
  buildProjectsSidebarSections,
  readExpandedProjectKeys,
  toggleExpandedProjectKey,
  writeExpandedProjectKeys,
  type ProjectsSidebarThread,
} from "./ProjectsSidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const THREAD_DOT_CLASS: Record<ProjectThreadBoardColumn, string> = {
  review: "bg-emerald-500 dark:bg-emerald-300/90",
  waiting: "bg-amber-500 dark:bg-amber-300/90",
  working: "bg-sky-500 dark:bg-sky-300/80",
  idle: "bg-muted-foreground/60",
  done: "bg-border",
};

const ATTENTION_DOT_CLASS = {
  waiting: "bg-amber-500 dark:bg-amber-300/90",
  review: "bg-emerald-500 dark:bg-emerald-300/90",
} as const;

function SidebarSectionHeading({ label }: { readonly label: string }) {
  return (
    <div className="px-(--sidebar-row-content-inset) pb-1 text-xs font-medium text-sidebar-muted-foreground">
      {label}
    </div>
  );
}

function ThreadNavRow({
  thread,
  project = null,
  isActive,
  nested = false,
  onSelect,
}: {
  readonly thread: ProjectsSidebarThread;
  readonly project?: ProjectFaviconProject | null;
  readonly isActive: boolean;
  readonly nested?: boolean;
  readonly onSelect: (thread: ProjectsSidebarThread) => void;
}) {
  const column = projectThreadBoardColumn(thread);
  const button = (
    <SidebarMenuButton
      size={nested ? "sm" : "default"}
      isActive={isActive}
      onClick={() => onSelect(thread)}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", THREAD_DOT_CLASS[column])} />
      {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
    </SidebarMenuButton>
  );
  if (nested) {
    return <SidebarMenuSubItem>{button}</SidebarMenuSubItem>;
  }
  return <SidebarMenuItem>{button}</SidebarMenuItem>;
}

export function ProjectsSidebar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const projectGroups = useSettingsProjectGroups();
  const threads = useQuietThreadShells();
  const { presentationById } = useEnvironments();
  const { shownTarget } = useShownThreadRouteTarget();
  const projectHomeMatch = useMatch({ from: "/_chat/projects/$projectKey", shouldThrow: false });
  const projectThreadsMatch = useMatch({
    from: "/_chat/projects/$projectKey_/threads",
    shouldThrow: false,
  });

  const activeThreadKey =
    shownTarget?.kind === "server" ? scopedThreadKey(shownTarget.threadRef) : null;
  const activeProjectKey =
    projectHomeMatch?.params.projectKey ?? projectThreadsMatch?.params.projectKey ?? null;

  const [expandedByProjectKey, setExpandedByProjectKey] = useState<Record<string, boolean>>(() =>
    readExpandedProjectKeys(),
  );

  const sections = buildProjectsSidebarSections({
    projectGroups,
    threads,
    getServerSettings: (environmentId) =>
      presentationById.get(environmentId)?.serverConfig?.settings,
  });

  const projectByMemberKey = new Map<string, ProjectFaviconProject>();
  for (const group of projectGroups) {
    if (group.isScratch) continue;
    for (const member of group.memberProjects) {
      if (member.isScratch) continue;
      projectByMemberKey.set(
        scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
        member,
      );
    }
  }
  const projectForThread = (thread: ProjectsSidebarThread) =>
    projectByMemberKey.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    ) ?? null;

  const openThread = (thread: ProjectsSidebarThread) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
  };

  const openProject = (projectKey: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey },
    });
  };

  const toggleProject = (projectKey: string) => {
    setExpandedByProjectKey((current) => {
      const next = toggleExpandedProjectKey(current, projectKey);
      writeExpandedProjectKeys(next);
      return next;
    });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarGroup>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => openCommandPalette()}
            className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            Search
          </button>
          <SidebarHeaderIconButton
            label="Add project"
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <FolderPlusIcon />
          </SidebarHeaderIconButton>
          <SidebarHeaderIconButton
            label="New thread"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              openCommandPalette({ open: "new-thread-in" });
            }}
          >
            <SquarePenIcon />
          </SidebarHeaderIconButton>
        </div>
      </SidebarGroup>
      <SidebarContent>
        {sections.needsYou.length > 0 ? (
          <SidebarGroup>
            <SidebarSectionHeading label="Needs you" />
            <SidebarMenu>
              {sections.needsYou.map((thread) => (
                <ThreadNavRow
                  key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                  thread={thread}
                  project={projectForThread(thread)}
                  isActive={
                    activeThreadKey ===
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                  }
                  onSelect={openThread}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}

        <SidebarGroup>
          <SidebarSectionHeading label="Projects" />
          {sections.projects.length === 0 ? (
            <p className="px-(--sidebar-row-content-inset) py-1 text-xs text-sidebar-muted-foreground">
              No projects yet
            </p>
          ) : (
            <SidebarMenu>
              {sections.projects.map(({ group, activeThreads, attentionCount, attentionTone }) => {
                const isExpanded = expandedByProjectKey[group.projectKey] === true;
                const isProjectActive = activeProjectKey === group.projectKey;
                return (
                  <SidebarMenuItem key={group.projectKey}>
                    <div
                      data-active={isProjectActive ? "true" : undefined}
                      className={cn(
                        "flex h-8 w-full items-center gap-1 rounded-(--control-radius) pr-1 transition-colors hover:bg-sidebar-row-hover",
                        isProjectActive && "bg-sidebar-row-selected",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => openProject(group.projectKey)}
                        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-(--control-radius) pl-(--sidebar-row-content-inset) pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ProjectFavicon project={group} className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
                          {group.displayName}
                        </span>
                        {!isExpanded && attentionTone && attentionCount > 0 ? (
                          <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-sidebar-muted-foreground">
                            <span
                              aria-hidden
                              className={cn(
                                "size-1.5 rounded-full",
                                ATTENTION_DOT_CLASS[attentionTone],
                              )}
                            />
                            <span>{attentionCount}</span>
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Collapse ${group.displayName}`
                            : `Expand ${group.displayName}`
                        }
                        onClick={() => toggleProject(group.projectKey)}
                        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ChevronDownIcon
                          aria-hidden
                          className={cn(
                            "size-3.5 transition-transform",
                            !isExpanded && "-rotate-90",
                          )}
                        />
                      </button>
                    </div>
                    {isExpanded ? (
                      activeThreads.length > 0 ? (
                        <SidebarMenuSub>
                          {activeThreads.map((thread) => (
                            <ThreadNavRow
                              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                              thread={thread}
                              nested
                              isActive={
                                activeThreadKey ===
                                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                              }
                              onSelect={openThread}
                            />
                          ))}
                        </SidebarMenuSub>
                      ) : (
                        <p className="py-1 pl-8 pr-2 text-xs text-sidebar-muted-foreground">
                          No active threads
                        </p>
                      )
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          )}
        </SidebarGroup>

        {sections.pinned.length > 0 ? (
          <SidebarGroup>
            <SidebarSectionHeading label="Pinned" />
            <SidebarMenu>
              {sections.pinned.map((thread) => (
                <ThreadNavRow
                  key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                  thread={thread}
                  project={projectForThread(thread)}
                  isActive={
                    activeThreadKey ===
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                  }
                  onSelect={openThread}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}

        {sections.otherThreads.length > 0 ? (
          <SidebarGroup>
            <SidebarSectionHeading label="Other threads" />
            <SidebarMenu>
              {sections.otherThreads.map((thread) => (
                <ThreadNavRow
                  key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                  thread={thread}
                  project={projectForThread(thread)}
                  isActive={
                    activeThreadKey ===
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                  }
                  onSelect={openThread}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
