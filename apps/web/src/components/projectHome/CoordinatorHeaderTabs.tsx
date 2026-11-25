import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { SettingsIcon } from "lucide-react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { sinceAwayDigestCount } from "./sinceAwayDigest.logic";
import { useProjectThreadBoard } from "./useProjectThreadBoard";

export function useIsProjectCoordinator(
  environmentId: EnvironmentId,
  projectId: ProjectId | null | undefined,
  threadId: ThreadId,
): boolean {
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return coordinatorThreadIdOf(serverSettings, projectId) === threadId;
}

export type ProjectView = "conversation" | "threads" | "library";

export function ProjectViewTabs({
  projectKey,
  active,
}: {
  readonly projectKey: string;
  readonly active: ProjectView;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { openCount, digest } = useProjectThreadBoard(projectKey);
  const hasDigestActivity = sinceAwayDigestCount(digest) > 0;
  const open = (view: ProjectView) => {
    if (view === active) return;
    if (view === "threads") {
      void navigate({ to: "/projects/$projectKey/threads", params: { projectKey } });
    } else if (view === "library") {
      void navigate({ to: "/projects/$projectKey/library", params: { projectKey } });
    } else {
      void navigate({ to: "/projects/$projectKey", params: { projectKey } });
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <ToggleGroup
        aria-label={gt("Project view")}
        variant="segmented"
        size="segmented"
        value={[active]}
        onValueChange={(next) => {
          const view = next.find((value): value is ProjectView => value !== active);
          if (view) open(view);
        }}
      >
        <Toggle value="conversation">
          <T>Conversation</T>
        </Toggle>
        <Toggle value="threads">
          <T>Threads</T>
          {openCount > 0 ? (
            <span className="text-muted-foreground tabular-nums">{openCount}</span>
          ) : null}
          {hasDigestActivity ? (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                digest.needsYou.length > 0
                  ? "bg-warning"
                  : digest.failed.length > 0
                    ? "bg-error"
                    : "bg-success",
              )}
            >
              <span className="sr-only">
                <T>New activity</T>
              </span>
            </span>
          ) : null}
        </Toggle>
        <Toggle value="library">
          <T>Library</T>
        </Toggle>
      </ToggleGroup>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gt("Project settings")}
              onClick={() =>
                void navigate({
                  to: "/settings/projects",
                  search: { project: projectKey, machine: undefined },
                })
              }
            />
          }
        >
          <SettingsIcon />
        </TooltipTrigger>
        <TooltipPopup>{gt("Project settings")}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** The coordinator thread is the project home, so its header carries the project's views. */
export function CoordinatorHeaderTabs({
  environmentId,
  project,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const projectKey = deriveLogicalProjectKeyFromSettings(
    project,
    selectProjectGroupingSettings(settings),
  );
  return <ProjectViewTabs projectKey={projectKey} active="conversation" />;
}
