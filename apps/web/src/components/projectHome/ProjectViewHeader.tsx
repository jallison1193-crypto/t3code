import { T, useGT } from "gt-react";

import { isElectron } from "~/env";
import type { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProjectViewTabs, type ProjectView } from "./CoordinatorHeaderTabs";
import { ProjectCrumb } from "./ProjectBreadcrumb";

/** The header of a project view outside a thread; the coordinator thread's is in ChatHeader. */
export function ProjectViewHeader({
  projectKey,
  group,
  view,
}: {
  readonly projectKey: string;
  readonly group: ReturnType<typeof useSettingsProjectGroups>[number] | null;
  readonly view: ProjectView;
}) {
  const gt = useGT();
  return (
    <WorkspacePageHeader electron={isElectron} className="bg-background">
      {/* Matches ChatHeader's room for the panel controls, so the tabs stay put between views. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 pr-24 sm:gap-3">
        <WorkspaceBreadcrumb
          ariaLabel={gt("Project breadcrumb")}
          className="flex-1 overflow-clip [overflow-clip-margin:2px]"
        >
          {group ? (
            <ProjectCrumb
              project={group}
              name={group.displayName}
              homeKey={view === "conversation" ? null : projectKey}
            />
          ) : null}
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
            <h1 className="min-w-0">
              <WorkspaceBreadcrumbText>
                {view === "conversation" ? (
                  <T>Conversation</T>
                ) : view === "threads" ? (
                  <T>Threads</T>
                ) : (
                  <T>Library</T>
                )}
              </WorkspaceBreadcrumbText>
            </h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {group ? <ProjectViewTabs projectKey={projectKey} active={view} /> : null}
      </div>
    </WorkspacePageHeader>
  );
}
