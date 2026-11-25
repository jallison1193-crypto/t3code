import type { ScopedThreadRef } from "@t3tools/contracts";
import type { CompanionWindowSize } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";
import {
  CheckIcon,
  CircleAlertIcon,
  EllipsisIcon,
  MinusIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ThreadRouteView } from "../ThreadRouteView";
import { Button } from "../ui/button";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type CompanionStatus = "working" | "attention" | "done";

const STATUS_DOT_CLASS: Record<CompanionStatus, string> = {
  working: "bg-sky-500 dark:bg-sky-300/80",
  attention: "bg-amber-500 dark:bg-amber-300/90",
  done: "bg-success",
};

// The bubble is too small for words in every language, so each state has its own shape.
const STATUS_ICON = { working: EllipsisIcon, attention: CircleAlertIcon, done: CheckIcon };

const STATUS_TEXT_CLASS: Record<CompanionStatus, string> = {
  working: "text-sky-500 dark:text-sky-300/80",
  attention: "text-amber-500 dark:text-amber-300/90",
  done: "text-success",
};

function useCompanionThread(threadRef: ScopedThreadRef) {
  const shell = useQuietThreadShell(threadRef);
  const gt = useGT();
  if (shell === null) return { title: null, status: null, statusLabel: null };
  const sidebarStatus = resolveSidebarThreadStatus(shell);
  const status: CompanionStatus =
    sidebarStatus === "preparing" || sidebarStatus === "working" || sidebarStatus === "waiting"
      ? "working"
      : sidebarStatus === "ready"
        ? "done"
        : "attention";
  const statusLabel =
    status === "working" ? gt("Working") : status === "done" ? gt("Done") : gt("Needs you");
  return { title: shell.title, status, statusLabel };
}

function StatusDot({ status, className }: { status: CompanionStatus | null; className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 rounded-full",
        status === null ? "bg-muted-foreground" : STATUS_DOT_CLASS[status],
        className,
      )}
    />
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={label} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The whole of the desktop companion window: one thread, at the size the settings ask for. */
export function CompanionView({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const size = useClientSettings((settings) => settings.companionWindowSize);
  const { title, status, statusLabel } = useCompanionThread(threadRef);
  const target: ThreadRouteTarget = { kind: "server", threadRef };
  const resize = (next: CompanionWindowSize) =>
    void updateClientSettings({ companionWindowSize: next });
  const bridge = window.desktopBridge?.companion;

  const StatusIcon = status === null ? EllipsisIcon : STATUS_ICON[status];

  if (size === "small") {
    // Sized in viewport units: the window shares the app's zoom but not its width.
    return (
      <main className="drag-region flex h-svh w-svw items-center justify-center bg-background">
        <button
          type="button"
          aria-label={statusLabel ?? gt("Expand companion window")}
          onClick={() => resize("medium")}
          className="flex size-[76vmin] items-center justify-center rounded-full border border-border outline-none [-webkit-app-region:no-drag] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <StatusIcon
            aria-hidden
            className={cn(
              "size-[40vmin]",
              status === null ? "text-muted-foreground" : STATUS_TEXT_CLASS[status],
            )}
          />
        </button>
      </main>
    );
  }

  const sizes: ReadonlyArray<{ value: CompanionWindowSize; short: string; label: string }> = [
    { value: "small", short: gt("S"), label: gt("Small") },
    { value: "medium", short: gt("M"), label: gt("Medium") },
    { value: "large", short: gt("L"), label: gt("Large") },
  ];

  return (
    <div className="flex h-svh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <StatusDot status={status} className="size-2" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {title}
          <span className="sr-only"> {statusLabel}</span>
        </h1>
        <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          <ToggleGroup
            aria-label={gt("Companion window size")}
            value={[size]}
            onValueChange={(value) => {
              const next = sizes.find((option) => option.value === value[0]);
              if (next) resize(next.value);
            }}
          >
            {sizes.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label}>
                {option.short}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <HeaderButton label={gt("Open in T3")} onClick={() => void bridge?.openInMain(threadRef)}>
            <SquareArrowOutUpRightIcon />
          </HeaderButton>
          <HeaderButton label={gt("Minimize")} onClick={() => void bridge?.minimize()}>
            <MinusIcon />
          </HeaderButton>
          <HeaderButton label={gt("Close")} onClick={() => void bridge?.close()}>
            <XIcon />
          </HeaderButton>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <ThreadRouteView target={target} companion={size} />
      </div>
    </div>
  );
}
