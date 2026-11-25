import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarModeFilter as Mode } from "@t3tools/contracts/settings";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  ChevronDownIcon,
  EllipsisIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { deriveBotSidebarEntries, filterNonBotThreads } from "~/bots/bots.logic";
import { openCommandPalette } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useHiddenThreadKeys, useQuietThreadShells } from "~/state/entities";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ThreadStatusDot } from "../ThreadStatusDot";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildProjectsSidebarSections,
  readExpandedProjectKeys,
  toggleExpandedProjectKey,
  writeExpandedProjectKeys,
  type ProjectsSidebarThread,
} from "./ProjectsSidebar.logic";
import { BotsSidebarSection } from "./BotsSidebarSection";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { SidebarModeFilter } from "./SidebarModeFilter";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { openThreadFolderDialog } from "./threadFolderDialogState";
import { resolveThreadFolderMembers, threadFolders } from "./threadFolders.logic";
import {
  readThreadFolderSource,
  readableThreadFolderSourcesAtom,
  threadFolderHomesAtom,
} from "./threadFoldersState";
import { useSidebarModeTabs } from "./useSidebarModeTabs";

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
  onChangeFolder,
  onSelect,
}: {
  readonly thread: ProjectsSidebarThread;
  readonly project?: ProjectFaviconProject | null;
  readonly isActive: boolean;
  readonly nested?: boolean;
  readonly onChangeFolder: () => void;
  readonly onSelect: (thread: ProjectsSidebarThread) => void;
}) {
  const button = (
    <SidebarMenuButton
      size={nested ? "sm" : "default"}
      isActive={isActive}
      onClick={() => onSelect(thread)}
    >
      <ThreadStatusDot thread={thread} />
      {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
    </SidebarMenuButton>
  );
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;
  return (
    <Item>
      <ThreadFolderMemberControls onChangeFolder={onChangeFolder}>
        {button}
      </ThreadFolderMemberControls>
    </Item>
  );
}

function ThreadFolderMemberControls({
  children,
  onChangeFolder,
}: {
  readonly children: ReactNode;
  readonly onChangeFolder: () => void;
}) {
  const gt = useGT();
  return (
    <div className="group/folder-member flex min-w-0 items-center">
      <div className="min-w-0 flex-1">{children}</div>
      <div className="shrink-0 opacity-100 pointer-fine:opacity-0 group-hover/folder-member:opacity-100 group-focus-within/folder-member:opacity-100">
        <SidebarHeaderIconButton label={gt("Change thread folder")} onClick={onChangeFolder}>
          <FolderInputIcon />
        </SidebarHeaderIconButton>
      </div>
    </div>
  );
}

export function ProjectsSidebar() {
  const gt = useGT();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const threads = useQuietThreadShells();
  const {
    activeProjectKey,
    activeThreadKey,
    activeThreadProject,
    effectiveModeFilter,
    getServerSettings,
    projectGroups,
    selectMode,
  } = useSidebarModeTabs();

  const [expandedByProjectKey, setExpandedByProjectKey] = useState<Record<string, boolean>>(() =>
    readExpandedProjectKeys(),
  );

  const sections = buildProjectsSidebarSections({
    projectGroups,
    threads,
    getServerSettings,
    modeFilter: effectiveModeFilter,
    activeProjectKey,
    activeThreadProject,
  });
  const botEntries = deriveBotSidebarEntries({
    projectGroups,
    threads,
    getServerSettings,
  });
  const nonBotThreads = filterNonBotThreads(threads, getServerSettings);

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

  const openScopedThread = (ref: ScopedThreadRef) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ref.environmentId, threadId: ref.threadId },
    });
  };
  const openThread = (thread: ProjectsSidebarThread) =>
    openScopedThread(scopeThreadRef(thread.environmentId, thread.id));
  const changeFolder = (thread: ProjectsSidebarThread) =>
    openThreadFolderDialog({
      kind: "membership",
      thread: scopeThreadRef(thread.environmentId, thread.id),
    });

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
            <T>Search</T>
          </button>
          <SidebarHeaderIconButton
            label={gt("Add project")}
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <FolderPlusIcon />
          </SidebarHeaderIconButton>
          <SidebarHeaderIconButton
            label={gt("New thread")}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              openCommandPalette({ open: "new-thread-in" });
            }}
          >
            <SquarePenIcon />
          </SidebarHeaderIconButton>
        </div>
        <div className="mt-1 px-1">
          <SidebarModeFilter
            label={gt("Thread mode filter")}
            activeMode={effectiveModeFilter}
            onModeSelect={selectMode}
          />
        </div>
      </SidebarGroup>
      <SidebarContent>
        {sections.needsYou.length > 0 ? (
          <SidebarGroup>
            <SidebarSectionHeading label={gt("Needs you")} />
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
                  onChangeFolder={() => changeFolder(thread)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}

        {effectiveModeFilter === "bots" ? (
          <BotsSidebarSection
            bots={botEntries}
            expandedByProjectKey={expandedByProjectKey}
            activeProjectKey={activeProjectKey}
            activeThreadKey={activeThreadKey}
            onToggleBot={toggleProject}
            onOpenBot={openProject}
            onOpenThread={openThread}
          />
        ) : (
          <>
            <ThreadFoldersSidebar
              threads={nonBotThreads}
              mode={effectiveModeFilter}
              activeThreadKey={activeThreadKey}
              onSelect={openScopedThread}
            />

            <SidebarGroup>
              <SidebarSectionHeading label={gt("Projects")} />
              {sections.projects.length === 0 ? (
                <p className="px-(--sidebar-row-content-inset) py-1 text-xs text-sidebar-muted-foreground">
                  {effectiveModeFilter === "work" ? (
                    <T>No projects with Work threads</T>
                  ) : effectiveModeFilter === "code" ? (
                    <T>No projects with Code threads</T>
                  ) : (
                    <T>No projects yet</T>
                  )}
                </p>
              ) : (
                <SidebarMenu>
                  {sections.projects.map(
                    ({ group, activeThreads, attentionCount, attentionTone }) => {
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
                                    role="img"
                                    aria-label={
                                      attentionTone === "waiting"
                                        ? gt("Waiting on you")
                                        : gt("Ready for review")
                                    }
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
                                  ? gt("Collapse {name}", { name: group.displayName })
                                  : gt("Expand {name}", { name: group.displayName })
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
                                    key={scopedThreadKey(
                                      scopeThreadRef(thread.environmentId, thread.id),
                                    )}
                                    thread={thread}
                                    nested
                                    isActive={
                                      activeThreadKey ===
                                      scopedThreadKey(
                                        scopeThreadRef(thread.environmentId, thread.id),
                                      )
                                    }
                                    onSelect={openThread}
                                    onChangeFolder={() => changeFolder(thread)}
                                  />
                                ))}
                              </SidebarMenuSub>
                            ) : (
                              <div className="flex items-center justify-between gap-2 py-1 pl-8 pr-2 text-xs text-sidebar-muted-foreground">
                                <span>
                                  <T>No active threads</T>
                                </span>
                                <Link
                                  to="/projects/$projectKey/threads"
                                  params={{ projectKey: group.projectKey }}
                                  onClick={() => {
                                    if (isMobile) setOpenMobile(false);
                                  }}
                                  className="shrink-0 font-medium text-sidebar-foreground/80 underline-offset-2 hover:text-sidebar-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                                >
                                  <T>Open Threads</T>
                                </Link>
                              </div>
                            )
                          ) : null}
                        </SidebarMenuItem>
                      );
                    },
                  )}
                </SidebarMenu>
              )}
            </SidebarGroup>

            {sections.pinned.length > 0 ? (
              <SidebarGroup>
                <SidebarSectionHeading label={gt("Pinned")} />
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
                      onChangeFolder={() => changeFolder(thread)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ) : null}

            {sections.otherThreads.length > 0 ? (
              <SidebarGroup>
                <SidebarSectionHeading label={gt("Other threads")} />
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
                      onChangeFolder={() => changeFolder(thread)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ) : null}
          </>
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function ThreadFoldersSidebar({
  threads,
  mode,
  activeThreadKey,
  onSelect,
}: {
  readonly threads: readonly ProjectsSidebarThread[];
  readonly mode: Mode;
  readonly activeThreadKey: string | null;
  readonly onSelect: (ref: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const homes = useAtomValue(threadFolderHomesAtom);
  const readableSources = useAtomValue(readableThreadFolderSourcesAtom);
  const hiddenKeys = useHiddenThreadKeys();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const hasMembers = homes.some((home) =>
    Object.values(home.sections).some((folder) => (folder.members?.length ?? 0) > 0),
  );
  const threadsByKey = new Map(
    (hasMembers ? threads : []).map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const folderEntries = homes.flatMap((home) =>
    threadFolders(home.sections).map((folder) => ({ home, folder })),
  );
  return (
    <SidebarGroup>
      <div className="flex items-center justify-between pr-1">
        <SidebarSectionHeading label={gt("Thread folders")} />
        <SidebarHeaderIconButton
          label={gt("New thread folder")}
          onClick={() => openThreadFolderDialog({ kind: "create" })}
        >
          <PlusIcon />
        </SidebarHeaderIconButton>
      </div>
      {folderEntries.length === 0 ? (
        <p className="px-(--sidebar-row-content-inset) py-1 text-xs text-sidebar-muted-foreground">
          <T>Group threads from any project.</T>
        </p>
      ) : (
        <SidebarMenu>
          {folderEntries.map(({ home, folder }) => {
            const key = `${home.id}:${folder.id}`;
            const expanded = !collapsed.has(key);
            const rows = expanded
              ? resolveThreadFolderMembers(
                  folder.members ?? [],
                  threadsByKey,
                  readableSources,
                  hiddenKeys,
                  mode,
                )
              : [];
            return (
              <SidebarMenuItem key={key}>
                <div className="flex items-center gap-1 pr-1">
                  <div className="min-w-0 flex-1">
                    <SidebarMenuButton
                      aria-expanded={expanded}
                      onClick={() => {
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (!next.delete(key)) next.add(key);
                          return next;
                        });
                      }}
                    >
                      <FolderIcon aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      {homes.length > 1 ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="max-w-[40%] truncate text-xs text-sidebar-muted-foreground" />
                            }
                          >
                            {home.label}
                          </TooltipTrigger>
                          <TooltipPopup>{home.label}</TooltipPopup>
                        </Tooltip>
                      ) : null}
                      <ChevronDownIcon aria-hidden className={cn(!expanded && "-rotate-90")} />
                    </SidebarMenuButton>
                  </div>
                  <Menu>
                    <MenuTrigger
                      aria-label={gt("Folder actions for {name}", { name: folder.name })}
                      render={<Button variant="ghost" size="icon-xs" />}
                    >
                      <EllipsisIcon />
                    </MenuTrigger>
                    <MenuPopup align="end">
                      <MenuItem
                        onClick={() =>
                          openThreadFolderDialog({
                            kind: "rename",
                            homeId: home.id,
                            sectionId: folder.id,
                            name: folder.name,
                          })
                        }
                      >
                        <T>Rename folder</T>
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        onClick={() =>
                          openThreadFolderDialog({
                            kind: "delete",
                            homeId: home.id,
                            sectionId: folder.id,
                            name: folder.name,
                          })
                        }
                      >
                        <T>Delete folder</T>
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
                {expanded ? (
                  rows.length > 0 ? (
                    <SidebarMenuSub>
                      {rows.map(({ ref, key, thread }) => {
                        const changeFolder = () =>
                          openThreadFolderDialog({
                            kind: "membership",
                            thread: ref,
                            homeId: home.id,
                          });
                        return thread ? (
                          <ThreadNavRow
                            key={key}
                            thread={thread}
                            nested
                            isActive={activeThreadKey === key}
                            onChangeFolder={changeFolder}
                            onSelect={() => {
                              if (readThreadFolderSource(ref)) onSelect(ref);
                            }}
                          />
                        ) : (
                          <SidebarMenuSubItem key={key}>
                            <ThreadFolderMemberControls onChangeFolder={changeFolder}>
                              <p className="truncate px-2 text-xs text-sidebar-muted-foreground">
                                <T>Thread unavailable</T>
                              </p>
                            </ThreadFolderMemberControls>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  ) : (
                    <p className="py-1 pl-8 pr-2 text-xs text-sidebar-muted-foreground">
                      <T>No threads to show</T>
                    </p>
                  )
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
