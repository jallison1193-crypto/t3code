import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { groupProjectBoardThreadsForMembers } from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { I18nProvider } from "../../i18n/I18nProvider";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { ProjectThreadsScreen } from "./ProjectThreadsScreen";
import {
  buildProjectThreadBoardSections,
  resolveProjectThreadsTarget,
  type ProjectThreadsRouteParams,
} from "./projectThreads.logic";

function ProjectThreadsRouteContent(props: {
  readonly params: ProjectThreadsRouteParams | undefined;
}) {
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const groupingSettings = useMobileProjectGroupingSettings();

  const environmentLabelsById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const project = useMemo(
    () => resolveProjectThreadsTarget(projects, groupingSettings, props.params),
    [groupingSettings, projects, props.params],
  );
  const sections = useMemo(() => {
    const columns = groupProjectBoardThreadsForMembers(
      threads,
      project?.members ?? [],
      (environmentId) => serverConfigs.get(environmentId)?.settings,
    );
    return buildProjectThreadBoardSections(columns);
  }, [project?.members, serverConfigs, threads]);

  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(thread.environmentId),
        threadId: String(thread.id),
      }),
    );
  };

  return (
    <ProjectThreadsScreen
      environmentLabelsById={environmentLabelsById}
      onBack={() => navigation.goBack()}
      onSelectThread={handleSelectThread}
      project={project}
      sections={sections}
    />
  );
}

export function ProjectThreadsRouteScreen({
  route,
}: StaticScreenProps<ProjectThreadsRouteParams | undefined>) {
  return (
    <I18nProvider>
      <ProjectThreadsRouteContent params={route.params} />
    </I18nProvider>
  );
}
