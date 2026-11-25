import { projectThreadBoardColumn } from "@t3tools/client-runtime/project-thread-board";
import { msg } from "gt-react";

import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";

// The stock pill is silent for threads that are idle, done, or never opened; rows still need a dot.
function quietStatus(thread: Parameters<typeof projectThreadBoardColumn>[0]): ThreadStatusPill {
  switch (projectThreadBoardColumn(thread)) {
    case "working":
      return {
        label: msg("Working"),
        colorClass: "text-sky-600 dark:text-sky-300/80",
        dotClass: "bg-sky-500 dark:bg-sky-300/80",
        pulse: false,
      };
    case "review":
      return {
        label: msg("Completed"),
        colorClass: "text-emerald-600 dark:text-emerald-300/90",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
        pulse: false,
      };
    case "done":
      return {
        label: msg("Done"),
        colorClass: "text-sidebar-muted-foreground",
        dotClass: "bg-border",
        pulse: false,
      };
    default:
      return {
        label: msg("Idle"),
        colorClass: "text-sidebar-muted-foreground",
        dotClass: "bg-muted-foreground/60",
        pulse: false,
      };
  }
}

type StatusThread = Parameters<typeof resolveThreadStatusPill>[0]["thread"] &
  Parameters<typeof projectThreadBoardColumn>[0];

/** The stock status for a thread, with a quiet fallback so every thread has a word for it. */
export function resolveThreadStatusDisplay(thread: StatusThread): ThreadStatusPill {
  return resolveThreadStatusPill({ thread }) ?? quietStatus(thread);
}

/** A thread row's status dot, in the stock status words and colors, with a text label. */
export function ThreadStatusDot({ thread }: { readonly thread: StatusThread }) {
  return <ThreadStatusLabel status={resolveThreadStatusDisplay(thread)} compact />;
}
