import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { CompanionView } from "../components/companion/CompanionView";
import { isCompanionWindow } from "../lib/companionWindow";

export const Route = createFileRoute("/companion/$environmentId/$threadId")({
  beforeLoad: ({ params }) => {
    // Only the desktop companion window has this chrome; anyone else gets the thread itself.
    if (!isCompanionWindow) {
      throw redirect({ to: "/$environmentId/$threadId", params, replace: true });
    }
  },
  component: CompanionRoute,
});

function CompanionRoute() {
  const { environmentId, threadId } = Route.useParams();
  const threadRef = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  return <CompanionView threadRef={threadRef} />;
}
