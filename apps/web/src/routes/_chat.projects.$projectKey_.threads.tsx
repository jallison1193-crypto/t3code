import { createFileRoute } from "@tanstack/react-router";

import { ProjectThreadsView } from "../components/projectHome/ProjectThreadsView";

function ProjectThreadsRoute() {
  const { projectKey } = Route.useParams();
  return <ProjectThreadsView projectKey={projectKey} />;
}

export const Route = createFileRoute("/_chat/projects/$projectKey_/threads")({
  component: ProjectThreadsRoute,
});
