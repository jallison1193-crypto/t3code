import { createFileRoute } from "@tanstack/react-router";

import { ProjectHomeView } from "../components/projectHome/ProjectHomeView";

function ProjectHomeRoute() {
  const { projectKey } = Route.useParams();
  return <ProjectHomeView projectKey={projectKey} />;
}

export const Route = createFileRoute("/_chat/projects/$projectKey")({
  component: ProjectHomeRoute,
});
