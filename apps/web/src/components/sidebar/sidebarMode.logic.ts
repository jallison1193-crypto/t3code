import {
  filterThreadsByMode,
  type ThreadModeSource,
} from "@t3tools/client-runtime/state/thread-mode";
import type { SidebarModeFilter } from "@t3tools/contracts/settings";

import { resolveBotRouteSidebarMode } from "~/bots/bots.logic";

export interface SidebarTabOverride {
  readonly routeKey: string;
  readonly mode: SidebarModeFilter;
}

export function resolveSidebarRouteKey(input: {
  readonly activeProjectKey: string | null;
  readonly activeThreadKey: string | null;
  readonly activeDraftId: string | null;
}): string {
  return (
    input.activeProjectKey ??
    input.activeThreadKey ??
    (input.activeDraftId !== null ? `draft:${input.activeDraftId}` : "")
  );
}

export function resolveSidebarEffectiveMode(input: {
  readonly savedMode: SidebarModeFilter;
  readonly botsEnabled: boolean;
  readonly isBotRoute: boolean;
  readonly routeKey: string;
  readonly tabOverride: SidebarTabOverride | null;
}): SidebarModeFilter {
  return resolveBotRouteSidebarMode({
    savedMode: input.savedMode,
    botsEnabled: input.botsEnabled,
    isBotRoute: input.isBotRoute,
    routeOverride:
      input.tabOverride !== null && input.tabOverride.routeKey === input.routeKey
        ? input.tabOverride.mode
        : null,
  });
}

export function filterThreadSidebarThreads<T extends ThreadModeSource>(
  threads: ReadonlyArray<T>,
  modeFilter: SidebarModeFilter,
  isSearching = false,
): ReadonlyArray<T> {
  // The Bots tab lists no threads, but a search typed there still has to find them.
  if (modeFilter === "bots") return isSearching ? threads : [];
  return filterThreadsByMode(threads, modeFilter);
}
