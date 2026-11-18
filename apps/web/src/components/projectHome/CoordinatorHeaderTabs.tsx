import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { coordinatorThreadIdOf } from "@t3tools/client-runtime/coordinator-thread";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function useIsProjectCoordinator(
  environmentId: EnvironmentId,
  projectId: ProjectId | null | undefined,
  threadId: ThreadId,
): boolean {
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return coordinatorThreadIdOf(serverSettings, projectId) === threadId;
}

/** The coordinator thread is the project home, so its header carries the project's views. */
export function CoordinatorHeaderTabs({
  environmentId,
  project,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const openProjectSettings = () => {
    void navigate({
      to: "/settings/projects",
      search: {
        project: deriveLogicalProjectKeyFromSettings(
          project,
          selectProjectGroupingSettings(settings),
        ),
        machine: undefined,
      },
    });
  };
  return (
    <div className="shrink-0 [-webkit-app-region:no-drag]">
      <ToggleGroup
        aria-label="Project view"
        variant="segmented"
        size="segmented"
        value={["conversation"]}
        onValueChange={(next) => {
          if (next.includes("settings")) openProjectSettings();
        }}
      >
        <Toggle value="conversation">Conversation</Toggle>
        <Toggle value="settings">Settings</Toggle>
      </ToggleGroup>
    </div>
  );
}
