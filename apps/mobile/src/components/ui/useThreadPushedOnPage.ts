import { NavigationContext, NavigationRouteContext } from "@react-navigation/native";
import { use, useSyncExternalStore } from "react";

const PAGES_THAT_PUSH_THREADS = new Set(["Thread", "ProjectThreads", "SettingsProjectOverview"]);

/** A thread opened from another thread or a project page sits on it, not beside the list, so it keeps Back. */
export function useThreadPushedOnPage(): boolean {
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);
  return useSyncExternalStore(
    (onChange) => navigation?.addListener("state", onChange) ?? (() => {}),
    () => {
      const routes = navigation?.getState()?.routes;
      const index = routes?.findIndex((candidate) => candidate.key === route?.key) ?? -1;
      const previousName = index > 0 ? routes?.[index - 1]?.name : undefined;
      return (
        route?.name === "Thread" &&
        previousName !== undefined &&
        PAGES_THAT_PUSH_THREADS.has(previousName)
      );
    },
  );
}
