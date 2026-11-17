import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { SettingsSection } from "./SettingsSection";

export type ProjectInstructionsSource = "environment" | "project" | "mixed";

export function ProjectInstructionsSettings(props: {
  readonly instructions: string | null;
  readonly source: ProjectInstructionsSource;
  readonly disabled: boolean;
  readonly pending?: boolean;
  readonly managedReason?: string;
  readonly onSave: (instructions: string) => void;
  readonly onClear: () => void;
}) {
  const gt = useGT();
  // Save on exit too: Android Back hides the keyboard without ending editing.
  const draft = useRef<{
    readonly text: string;
    readonly over: string | null;
    readonly source: ProjectInstructionsSource;
  } | null>(null);

  const take = ():
    | { readonly kind: "save"; readonly value: string }
    | { readonly kind: "clear" }
    | null => {
    const current = draft.current;
    draft.current = null;
    // Drop a draft typed over an older saved value: the updated value has already remounted its input.
    if (
      current === null ||
      current.over !== props.instructions ||
      current.source !== props.source
    ) {
      return null;
    }
    const value = current.text.trim();
    if (value === "") {
      return props.source === "project" || props.source === "mixed" ? { kind: "clear" } : null;
    }
    return props.instructions === null || value !== props.instructions
      ? { kind: "save", value }
      : null;
  };

  const commitDraft = () => {
    const action = take();
    if (!action) return;
    if (action.kind === "clear") {
      props.onClear();
    } else {
      props.onSave(action.value);
    }
  };

  const saveDrafts = useEffectEvent(() => commitDraft());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves unsent project instructions drafts to server settings when the section unmounts
  useEffect(() => () => saveDrafts(), []);

  const hasOverride = props.source === "project" || props.source === "mixed";

  return (
    <SettingsSection
      title={gt("Project instructions")}
      footer={props.managedReason}
      trailing={
        props.pending ? null : props.source === "mixed" ? (
          <Text className="px-2 text-sm text-foreground-muted android:px-4">{gt("Mixed")}</Text>
        ) : props.source === "project" ? (
          <Text className="px-2 text-sm text-foreground-muted android:px-4">
            {gt("Overridden")}
          </Text>
        ) : null
      }
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          {gt("Shared with every thread in this project, whatever the provider.")}
        </Text>
        <AppTextInput
          key={`${props.source}:${props.instructions ?? "mixed"}`}
          accessibilityLabel={gt("Project instructions")}
          onChangeText={(text) => {
            draft.current = { text, over: props.instructions, source: props.source };
          }}
          defaultValue={props.instructions ?? ""}
          placeholder={
            props.instructions === null
              ? gt("Mixed. Enter instructions to apply to all selected targets.")
              : undefined
          }
          editable={!props.disabled}
          multiline
          autoCapitalize="sentences"
          className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={commitDraft}
        />
        {hasOverride && !props.pending ? (
          <View className="flex-row justify-end">
            <Button
              label={gt("Use default")}
              accessibilityHint={gt("Use inherited project instructions")}
              tone="text"
              size="compact"
              disabled={props.disabled}
              onPress={() => {
                draft.current = null;
                props.onClear();
              }}
            />
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}
