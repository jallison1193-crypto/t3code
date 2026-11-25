import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  projectThreadBoardColumn,
  type ProjectThreadBoardColumn,
} from "@t3tools/client-runtime/project-thread-board";
import { T, useGT } from "gt-react";
import { BotIcon, ChevronDownIcon, PlusIcon } from "lucide-react";

import type { BotSidebarEntry } from "~/bots/bots.logic";
import { openNewBotDialog } from "~/bots/newBotDialogState";
import { useBotWritableEnvironments } from "~/bots/useBots";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import type { ProjectsSidebarGroupInput, ProjectsSidebarThread } from "./ProjectsSidebar.logic";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const THREAD_DOT_CLASS: Record<ProjectThreadBoardColumn, string> = {
  review: "bg-emerald-500 dark:bg-emerald-300/90",
  waiting: "bg-amber-500 dark:bg-amber-300/90",
  working: "bg-sky-500 dark:bg-sky-300/80",
  idle: "bg-muted-foreground/60",
  done: "bg-border",
};

export function BotsSidebarSection<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
>({
  bots,
  expandedByProjectKey,
  activeProjectKey,
  activeThreadKey,
  onToggleBot,
  onOpenBot,
  onOpenThread,
}: {
  readonly bots: ReadonlyArray<BotSidebarEntry<TGroup, TThread>>;
  readonly expandedByProjectKey: Readonly<Record<string, boolean>>;
  readonly activeProjectKey: string | null;
  readonly activeThreadKey: string | null;
  readonly onToggleBot: (projectKey: string) => void;
  readonly onOpenBot: (projectKey: string) => void;
  readonly onOpenThread: (thread: TThread) => void;
}) {
  const gt = useGT();
  const writableEnvironments = useBotWritableEnvironments();
  const canCreate = writableEnvironments.length > 0;

  return (
    <SidebarGroup>
      <div className="flex items-center justify-between pr-1">
        <div className="px-(--sidebar-row-content-inset) pb-1 text-xs font-medium text-sidebar-muted-foreground">
          <T>Bots</T>
        </div>
        {canCreate ? (
          <SidebarHeaderIconButton label={gt("New bot")} onClick={() => openNewBotDialog()}>
            <PlusIcon />
          </SidebarHeaderIconButton>
        ) : null}
      </div>

      {bots.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-(--sidebar-row-content-inset) py-1.5">
          <p className="text-xs text-sidebar-muted-foreground">
            <T>No bots yet. Create one to run on a schedule or webhook.</T>
          </p>
          {canCreate ? (
            <Button variant="outline" size="xs" onClick={() => openNewBotDialog()}>
              <PlusIcon className="size-3.5" />
              <T>New bot</T>
            </Button>
          ) : null}
        </div>
      ) : (
        <SidebarMenu>
          {bots.map((bot) => {
            const isExpanded = expandedByProjectKey[bot.group.projectKey] === true;
            const isBotActive = activeProjectKey === bot.group.projectKey;
            return (
              <SidebarMenuItem key={bot.group.projectKey}>
                <div
                  data-active={isBotActive ? "true" : undefined}
                  className={cn(
                    "flex h-8 w-full items-center gap-1 rounded-(--control-radius) pr-1 transition-colors hover:bg-sidebar-row-hover",
                    isBotActive && "bg-sidebar-row-selected",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onOpenBot(bot.group.projectKey)}
                    className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--control-radius) pl-(--sidebar-row-content-inset) pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <BotIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
                      {bot.name}
                    </span>
                    {bot.paused ? (
                      <Badge variant="outline" size="sm">
                        <T>Paused</T>
                      </Badge>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-label={
                      isExpanded
                        ? gt("Collapse {name}", { name: bot.name })
                        : gt("Expand {name}", { name: bot.name })
                    }
                    onClick={() => onToggleBot(bot.group.projectKey)}
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ChevronDownIcon
                      aria-hidden
                      className={cn("size-3.5 transition-transform", !isExpanded && "-rotate-90")}
                    />
                  </button>
                </div>
                {isExpanded ? (
                  bot.runThreads.length > 0 ? (
                    <SidebarMenuSub>
                      {bot.runThreads.map((thread) => {
                        const key = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        const column = projectThreadBoardColumn(thread);
                        return (
                          <SidebarMenuSubItem key={key}>
                            <SidebarMenuButton
                              size="sm"
                              isActive={activeThreadKey === key}
                              onClick={() => onOpenThread(thread)}
                            >
                              <span
                                aria-hidden
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  THREAD_DOT_CLASS[column],
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                            </SidebarMenuButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  ) : (
                    <p className="py-1 pl-8 pr-2 text-xs text-sidebar-muted-foreground">
                      <T>No runs yet</T>
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
