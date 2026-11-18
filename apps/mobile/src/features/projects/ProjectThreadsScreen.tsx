import type { ProjectThreadBoardColumn } from "@t3tools/client-runtime/project-thread-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import type {
  ProjectThreadBoardSection,
  ResolvedProjectThreadsTarget,
} from "./projectThreads.logic";

const COLUMN_DOT_CLASS = {
  review: "bg-adaptive-emerald-600-400",
  waiting: "bg-warning-foreground",
  working: "bg-adaptive-sky-600-400",
  idle: "bg-foreground-muted",
  done: "bg-border",
} as const satisfies Record<ProjectThreadBoardColumn, string>;

function columnLabel(gt: ReturnType<typeof useGT>, column: ProjectThreadBoardColumn): string {
  switch (column) {
    case "review":
      return gt("Ready for review");
    case "waiting":
      return gt("Waiting on you");
    case "working":
      return gt("Working");
    case "idle":
      return gt("Idle");
    case "done":
      return gt("Done");
  }
}

function BoardThreadRow(props: {
  readonly environmentLabel: string | null;
  readonly isDone: boolean;
  readonly isLast: boolean;
  readonly onPress: () => void;
  readonly thread: EnvironmentThreadShell;
}) {
  const subtitleParts = [props.environmentLabel, props.thread.branch].filter(
    (part): part is string => Boolean(part),
  );
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.thread.title, ...subtitleParts].join(", ")}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-3 bg-grouped-card px-4 py-3",
        !props.isLast && "border-b border-separator",
      )}
    >
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className={cn(
              "min-w-0 flex-1 text-base font-t3-medium leading-snug",
              props.isDone ? "text-foreground-muted" : "text-foreground",
            )}
            numberOfLines={2}
          >
            {props.thread.title}
          </Text>
          <Text className="shrink-0 text-xs tabular-nums text-foreground-tertiary">
            <RelativeTime timestamp={props.thread.updatedAt} />
          </Text>
        </View>
        {subtitleParts.length > 0 ? (
          <View className="flex-row items-center gap-1.5">
            <SymbolView
              name="arrow.triangle.branch"
              size={10}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
            <Text
              className="min-w-0 flex-1 font-mono text-2xs text-foreground-tertiary"
              numberOfLines={1}
            >
              {subtitleParts.join(" · ")}
            </Text>
          </View>
        ) : null}
      </View>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
        weight="semibold"
      />
    </RowPressable>
  );
}

function BoardSectionHeader(props: {
  readonly collapsible: boolean;
  readonly column: ProjectThreadBoardColumn;
  readonly count: number;
  readonly expanded: boolean;
  readonly label: string;
  readonly onToggle?: () => void;
}) {
  const content = (
    <View
      className={cn(
        "flex-row items-center justify-between gap-3 py-1",
        Platform.OS === "android" ? "px-4" : "px-2",
      )}
    >
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <View className={cn("size-2 shrink-0 rounded-full", COLUMN_DOT_CLASS[props.column])} />
        <Text textRole="footnote" className="shrink font-t3-medium text-foreground-muted">
          {props.label}
        </Text>
        <Text textRole="footnote" className="tabular-nums text-foreground-tertiary">
          {props.count}
        </Text>
      </View>
      {props.collapsible ? (
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={14}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </View>
  );

  if (!props.collapsible || !props.onToggle) return content;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.count}`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className="active:opacity-70"
    >
      {content}
    </Pressable>
  );
}

export function ProjectThreadsScreen(props: {
  readonly environmentLabelsById: ReadonlyMap<EnvironmentId, string>;
  readonly onBack: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly project: ResolvedProjectThreadsTarget | null;
  readonly sections: readonly ProjectThreadBoardSection[];
}) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const showEnvironmentLabel = (props.project?.members.length ?? 0) > 1;
  const groupRadius =
    Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={gt("Threads")}
        subtitle={props.project?.displayName}
        onBack={props.onBack}
        hideBottomBorder
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{
            flexGrow: props.project === null || props.sections.length === 0 ? 1 : undefined,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          {props.project === null ? (
            <View className="flex-1 items-center justify-center">
              <EmptyState
                variant="plain"
                title={gt("Project not found")}
                detail={gt("This project could not be found in your connected environments.")}
              />
            </View>
          ) : props.sections.length === 0 ? (
            <View className="flex-1 items-center justify-center">
              <EmptyState
                variant="plain"
                title={gt("No threads yet")}
                detail={gt("Threads started in this project show up here by status.")}
              />
            </View>
          ) : (
            props.sections.map((section) => {
              const expanded = !section.defaultCollapsed || doneExpanded;
              return (
                <View key={section.column} className="gap-2">
                  <BoardSectionHeader
                    collapsible={section.defaultCollapsed}
                    column={section.column}
                    count={section.count}
                    expanded={expanded}
                    label={columnLabel(gt, section.column)}
                    onToggle={
                      section.defaultCollapsed
                        ? () => setDoneExpanded((current) => !current)
                        : undefined
                    }
                  />
                  {expanded ? (
                    <View
                      className="overflow-hidden border-continuous bg-grouped-card"
                      style={{ borderRadius: groupRadius }}
                    >
                      {section.threads.map((thread, index) => (
                        <BoardThreadRow
                          key={`${thread.environmentId}:${thread.id}`}
                          thread={thread}
                          environmentLabel={
                            showEnvironmentLabel
                              ? (props.environmentLabelsById.get(thread.environmentId) ?? null)
                              : null
                          }
                          isDone={section.column === "done"}
                          isLast={index === section.threads.length - 1}
                          onPress={() => props.onSelectThread(thread)}
                        />
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
