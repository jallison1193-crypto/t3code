import { useGT } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import { I18nProvider } from "../../i18n/I18nProvider";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export interface ThreadHeaderProps {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly onOpenProjectThreads?: () => void;
}

function ThreadHeaderContent(
  props: ThreadHeaderProps & {
    readonly coordinatorMenuTitle?: string;
    readonly projectThreadsTitle?: string;
  },
) {
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const coordinatorMenu: AppBarMenu | null = props.onOpenProjectThreads
    ? {
        title: props.coordinatorMenuTitle ?? "Coordinator",
        icon: "robot",
        separateBackground: false,
        items: [
          {
            id: "project-threads",
            title: props.projectThreadsTitle ?? "Project threads",
            icon: "text.bubble",
            onPress: props.onOpenProjectThreads,
          },
        ],
      }
    : null;
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [coordinatorMenu, gitMenu, terminalMenu].filter(
    (menu): menu is AppBarMenu => menu !== null,
  );

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}

function TranslatedThreadHeader(props: ThreadHeaderProps) {
  const gt = useGT();
  return (
    <ThreadHeaderContent
      {...props}
      coordinatorMenuTitle={gt("Coordinator")}
      projectThreadsTitle={gt("Project threads")}
    />
  );
}

export function ThreadHeader(props: ThreadHeaderProps) {
  if (!props.onOpenProjectThreads) {
    return <ThreadHeaderContent {...props} />;
  }
  return (
    <I18nProvider
      fallback={
        <ThreadHeaderContent
          {...props}
          coordinatorMenuTitle="Coordinator"
          projectThreadsTitle="Project threads"
        />
      }
    >
      <TranslatedThreadHeader {...props} />
    </I18nProvider>
  );
}
