import { createFileRoute } from "@tanstack/react-router";

import { ProjectLibraryPage } from "../components/htmlLibrary/HtmlLibraryPage";

export const Route = createFileRoute("/_chat/projects/$projectKey_/library")({
  component: ProjectLibraryRoute,
});

function ProjectLibraryRoute() {
  const { projectKey } = Route.useParams();
  return <ProjectLibraryPage projectKey={projectKey} />;
}
