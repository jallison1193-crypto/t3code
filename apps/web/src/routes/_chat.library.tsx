import { createFileRoute } from "@tanstack/react-router";

import { HtmlLibraryPage } from "../components/htmlLibrary/HtmlLibraryPage";

export const Route = createFileRoute("/_chat/library")({
  component: HtmlLibraryPage,
});
