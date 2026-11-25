import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { deriveBotSidebarEntries, type BotSettingsLookup } from "~/bots/bots.logic";
import { useQuietThreadShells } from "~/state/entities";
import { useSidebar } from "../ui/sidebar";
import { BotsSidebarSection } from "./BotsSidebarSection";
import {
  readExpandedProjectKeys,
  toggleExpandedProjectKey,
  writeExpandedProjectKeys,
  type ProjectsSidebarGroupInput,
  type ProjectsSidebarThread,
} from "./ProjectsSidebar.logic";

export function ThreadSidebarBotsPanel<TGroup extends ProjectsSidebarGroupInput>({
  projectGroups,
  getServerSettings,
  activeProjectKey,
  activeThreadKey,
}: {
  readonly projectGroups: ReadonlyArray<TGroup>;
  readonly getServerSettings: BotSettingsLookup;
  readonly activeProjectKey: string | null;
  readonly activeThreadKey: string | null;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const threads = useQuietThreadShells();
  const [expandedByProjectKey, setExpandedByProjectKey] = useState<Record<string, boolean>>(() =>
    readExpandedProjectKeys(),
  );
  const botEntries = deriveBotSidebarEntries({
    projectGroups,
    threads,
    getServerSettings,
  });

  const toggleBot = (projectKey: string) => {
    setExpandedByProjectKey((current) => {
      const next = toggleExpandedProjectKey(current, projectKey);
      writeExpandedProjectKeys(next);
      return next;
    });
  };
  const openBot = (projectKey: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey },
    });
  };
  const openThread = (thread: ProjectsSidebarThread) => {
    if (isMobile) setOpenMobile(false);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ref.environmentId, threadId: ref.threadId },
    });
  };

  return (
    <BotsSidebarSection
      bots={botEntries}
      expandedByProjectKey={expandedByProjectKey}
      activeProjectKey={activeProjectKey}
      activeThreadKey={activeThreadKey}
      onToggleBot={toggleBot}
      onOpenBot={openBot}
      onOpenThread={openThread}
    />
  );
}
