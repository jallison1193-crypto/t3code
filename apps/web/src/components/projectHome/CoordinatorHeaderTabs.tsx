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

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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

type ProjectView = "conversation" | "threads" | "library" | "settings";

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
    if (view === "settings") {
      void navigate({
        to: "/settings/projects",
        search: { project: projectKey, machine: undefined },
      });
    } else if (view === "threads") {
      void navigate({ to: "/projects/$projectKey/threads", params: { projectKey } });
    } else if (view === "library") {
      void navigate({ to: "/projects/$projectKey/library", params: { projectKey } });
    } else {
      void navigate({ to: "/projects/$projectKey", params: { projectKey } });
    }
  };
  return (
    <div className="shrink-0 [-webkit-app-region:no-drag]">
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
        <Toggle value="settings">
          <T>Settings</T>
        </Toggle>
      </ToggleGroup>
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
