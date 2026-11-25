import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarModeFilter as Mode } from "@t3tools/contracts/settings";
import { useMatch } from "@tanstack/react-router";
import { useState } from "react";

import { isBotSidebarRoute } from "~/bots/bots.logic";
import { useAnyBotsEnabled } from "~/bots/useBots";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { useShownThreadRouteTarget } from "~/hooks/useShownThreadRouteTarget";
import { useQuietThreadShell, useServerConfigs } from "~/state/entities";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  resolveSidebarEffectiveMode,
  resolveSidebarRouteKey,
  type SidebarTabOverride,
} from "./sidebarMode.logic";

export function useSidebarModeTabs() {
  const projectGroups = useSettingsProjectGroups({ includeBots: true });
  const serverConfigs = useServerConfigs();
  const botsEnabled = useAnyBotsEnabled();
  const { shownTarget } = useShownThreadRouteTarget();
  const projectHomeMatch = useMatch({ from: "/_chat/projects/$projectKey", shouldThrow: false });
  const projectThreadsMatch = useMatch({
    from: "/_chat/projects/$projectKey_/threads",
    shouldThrow: false,
  });
  const projectLibraryMatch = useMatch({
    from: "/_chat/projects/$projectKey_/library",
    shouldThrow: false,
  });

  const activeThreadKey =
    shownTarget?.kind === "server" ? scopedThreadKey(shownTarget.threadRef) : null;
  const activeServerThread = useQuietThreadShell(
    shownTarget?.kind === "server" ? shownTarget.threadRef : null,
  );
  const activeDraftSession = useComposerDraftStore((state) =>
    shownTarget?.kind === "draft" ? state.getDraftSession(shownTarget.draftId) : null,
  );
  const activeProjectKey =
    projectHomeMatch?.params.projectKey ??
    projectThreadsMatch?.params.projectKey ??
    projectLibraryMatch?.params.projectKey ??
    null;
  const routeKey = resolveSidebarRouteKey({
    activeProjectKey,
    activeThreadKey,
    activeDraftId: shownTarget?.kind === "draft" ? shownTarget.draftId : null,
  });

  const [tabOverride, setTabOverride] = useState<SidebarTabOverride | null>(null);
  const sidebarModeFilter = useClientSettings((settings) => settings.sidebarModeFilter);
  const getServerSettings = (environmentId: EnvironmentId) =>
    serverConfigs.get(environmentId)?.settings;
  const activeThreadProject =
    activeServerThread !== null
      ? { environmentId: activeServerThread.environmentId, projectId: activeServerThread.projectId }
      : activeDraftSession !== null
        ? {
            environmentId: activeDraftSession.environmentId,
            projectId: activeDraftSession.projectId,
          }
        : null;
  const isBotRoute = isBotSidebarRoute({
    activeProjectKey,
    activeThreadProject,
    projectGroups,
    getServerSettings,
  });
  const effectiveModeFilter = resolveSidebarEffectiveMode({
    savedMode: sidebarModeFilter,
    botsEnabled,
    isBotRoute,
    routeKey,
    tabOverride,
  });
  const selectMode = (mode: Mode) => setTabOverride({ routeKey, mode });

  return {
    activeProjectKey,
    activeThreadKey,
    activeThreadProject,
    effectiveModeFilter,
    getServerSettings,
    projectGroups,
    selectMode,
  };
}
