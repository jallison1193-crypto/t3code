import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useGT } from "gt-react";
import type { ComponentProps } from "react";

import { ProjectFavicon } from "../ProjectFavicon";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

/** The "project /" lead of a header breadcrumb. With `homeKey`, the name opens the project's home. */
export function ProjectCrumb({
  project,
  name,
  homeKey,
}: {
  readonly project: ComponentProps<typeof ProjectFavicon>["project"];
  readonly name: string;
  readonly homeKey: string | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const label = (
    <>
      <ProjectFavicon project={project} className="size-3.5" />
      <MiddleTruncate
        data-slot="workspace-breadcrumb-text"
        value={name}
        showTitle={false}
        variant="cap-aligned"
      />
    </>
  );
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        {homeKey === null ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">{label}</span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("Open project home for {project}", { project: name })}
                  onClick={() =>
                    void navigate({ to: "/projects/$projectKey", params: { projectKey: homeKey } })
                  }
                  className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              {label}
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Open project home")}</TooltipPopup>
          </Tooltip>
        )}
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}

/** The project lead for a thread's header; `isHome` marks the coordinator, which is the home. */
export function ThreadProjectCrumb({
  project,
  isHome,
}: {
  readonly project: EnvironmentProject;
  readonly isHome: boolean;
}) {
  const group = useSettingsProjectGroups({ includeBots: true }).find((candidate) =>
    candidate.memberProjectRefs.some(
      (ref) => ref.environmentId === project.environmentId && ref.projectId === project.id,
    ),
  );
  // The coordinator is a project view, so it names the group as Threads and Library do.
  const homeView = isHome ? group : undefined;
  return (
    <ProjectCrumb
      project={homeView ?? project}
      name={homeView?.displayName ?? project.title}
      homeKey={isHome ? null : (group?.projectKey ?? null)}
    />
  );
}
