import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, Maximize2Icon, XIcon } from "lucide-react";
import { Option } from "effect";
import { useEffect } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { hostRightPanel } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";

/** A thread opened beside its project's coordinator: its live chat, steerable in place. */
export default function ThreadBesidePane(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, threadId } = props;
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store
  useEffect(
    () => hostRightPanel(scopeThreadRef(parentRef.environmentId, threadId), parentRef),
    [parentRef, threadId],
  );
  // Idle children can be left out of the shell; then the title comes from the detail the
  // embedded chat already streams.
  const shell = useQuietThreadShell(threadRef);
  const detail = useEnvironmentThread(
    shell === null ? parentRef.environmentId : null,
    shell === null ? threadId : null,
  );
  const title =
    shell?.title ?? Option.getOrNull(Option.map(detail.data, (data) => data.thread.title));

  return (
    // The side chat marker keeps the coordinator's shortcuts and focus out of this chat.
    <div data-side-chat-pane={threadId} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-xs">
          <span className="shrink-0 text-muted-foreground">Threads</span>
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">{title ?? "Thread"}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open full size"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            })
          }
        >
          <Maximize2Icon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close thread" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      <BackgroundThreadContext value>
        <ComposerHandleContext value={null}>
          <ChatView
            environmentId={parentRef.environmentId}
            threadId={threadId}
            routeKind="server"
            embedded={props.parentPanel}
          />
        </ComposerHandleContext>
      </BackgroundThreadContext>
    </div>
  );
}
