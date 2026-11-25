import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";

/** Shows the thread the companion window's "Open in T3" asks for. */
export function CompanionThreadCoordinator() {
  const navigate = useNavigate();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to requests the desktop shell forwards from the companion window
  useEffect(
    () =>
      window.desktopBridge?.companion?.onShowThread((thread) => {
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(thread) });
      }),
    [navigate],
  );
  return null;
}
