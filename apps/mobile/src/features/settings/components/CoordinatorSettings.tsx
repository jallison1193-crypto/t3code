import {
  buildCoordinatorPatch,
  coordinatorThreadIdOf,
} from "@t3tools/client-runtime/coordinator-thread";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { useThreadShell } from "../../../state/entities";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import {
  managedSettingReason,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "../settings-scoped-server";
import { useSettingsWriter } from "../useSettingsWriter";
import type { ProjectInstructionsSource } from "./ProjectInstructionsSettings";
import { SettingsSection } from "./SettingsSection";

function resolveCoordinatorInstructionsSource(
  targets: readonly ScopedMobileSettingsTarget[],
): ProjectInstructionsSource {
  if (targets.length === 0) return "environment";
  const first = targets[0]!;
  const firstSource = first.sources.coordinatorInstructions;
  if (
    targets.some(
      (target) =>
        target.sources.coordinatorInstructions !== firstSource ||
        target.settings.coordinatorInstructions !== first.settings.coordinatorInstructions,
    )
  ) {
    return "mixed";
  }
  return firstSource === "project" ? "project" : "environment";
}

function CoordinatorThreadSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly serverSettings: ServerSettings | undefined;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const [isClearing, setIsClearing] = useState(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "clear coordinator thread",
    reportFailure: false,
  });
  const coordinatorThreadId = coordinatorThreadIdOf(props.serverSettings, props.projectId);
  const thread = useThreadShell(
    coordinatorThreadId === null ? null : scopeThreadRef(props.environmentId, coordinatorThreadId),
  );
  const label =
    coordinatorThreadId === null ? gt("None") : (thread?.title ?? gt("Thread not found"));

  const handleClear = () => {
    if (!props.serverSettings || coordinatorThreadId === null || isClearing) return;
    setIsClearing(true);
    void updateSettings({
      environmentId: props.environmentId,
      input: { patch: buildCoordinatorPatch(props.serverSettings, props.projectId, null) },
    })
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Dialog.alert(
            gt("Could not clear coordinator thread"),
            error instanceof Error ? error.message : gt("Try again."),
          );
        }
      })
      .finally(() => {
        setIsClearing(false);
      });
  };

  return (
    <SettingsSection title={gt("Coordinator thread")}>
      <View className="flex-row items-center justify-between gap-3 px-4 py-3">
        <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={2}>
          {label}
        </Text>
        {coordinatorThreadId !== null ? (
          <Button
            label={gt("Clear")}
            accessibilityHint={gt("Remove the designated coordinator thread")}
            tone="secondary"
            size="compact"
            disabled={!props.canWrite || isClearing}
            onPress={handleClear}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

export function CoordinatorSettings(props: {
  readonly environments: readonly SettingsTarget[];
  readonly members: readonly EnvironmentProject[];
}) {
  const gt = useGT();
  const settingsTargets = resolveMobileSettingsTargets(props.environments, props.members);
  const writableSettingsEnvironments = useEnvironmentsWithScope(
    props.environments,
    AuthSettingsWriteScope,
  );
  const canWriteSettings =
    settingsTargets.length > 0 &&
    settingsTargets.every((target) =>
      writableSettingsEnvironments.has(target.environment.environmentId),
    );
  const writeSettings = useSettingsWriter();
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const queuedAction = useRef<
    | { readonly key: string; readonly kind: "save"; readonly value: string }
    | { readonly key: string; readonly kind: "clear" }
    | null
  >(null);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const targetsKey = settingsTargets
    .map((target) => `${target.environment.environmentId}:${target.projectId}`)
    .join(",");
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : settingsTargets;
  const managedReason = managedSettingReason(settingsTargets, "coordinatorInstructions");
  const disabled = !canWriteSettings || pendingWrites > 0 || managedReason !== undefined;
  const instructions = uniformMobileSetting(displayTargets, "coordinatorInstructions");
  const source = resolveCoordinatorInstructionsSource(displayTargets);

  const runAction = (
    action: { readonly kind: "save"; readonly value: string } | { readonly kind: "clear" },
  ) => {
    if (writeInFlight.current) {
      queuedAction.current = { key: targetsKey, ...action };
      return;
    }
    if (
      settingsTargets.length === 0 ||
      !settingsTargets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    ) {
      return;
    }
    const writes =
      action.kind === "clear"
        ? planMobileScopedSettingsClear(settingsTargets, ["coordinatorInstructions"])
        : planMobileScopedSettingsPatch(settingsTargets, true, {
            coordinatorInstructions: action.value,
          });
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(settingsTargets);
    setPendingWrites((count) => count + 1);
    void writeSettings(settingsTargets, writes).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
      const queued = queuedAction.current;
      queuedAction.current = null;
      if (queued?.key === targetsKey) {
        runAction(
          queued.kind === "clear" ? { kind: "clear" } : { kind: "save", value: queued.value },
        );
      }
    });
  };

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
    if (current === null || current.over !== instructions || current.source !== source) {
      return null;
    }
    const value = current.text.trim();
    if (value === "") {
      return source === "project" || source === "mixed" ? { kind: "clear" } : null;
    }
    return instructions === null || value !== instructions ? { kind: "save", value } : null;
  };

  const commitDraft = () => {
    const action = take();
    if (!action) return;
    if (action.kind === "clear") {
      runAction({ kind: "clear" });
    } else {
      runAction({ kind: "save", value: action.value });
    }
  };

  const saveDrafts = useEffectEvent(() => commitDraft());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves unsent coordinator instructions drafts to server settings when the section unmounts
  useEffect(() => () => saveDrafts(), []);

  const hasOverride = source === "project" || source === "mixed";
  const singleMember = props.members.length === 1 ? props.members[0] : undefined;
  const singleEnvironment = singleMember
    ? props.environments.find((env) => env.environmentId === singleMember.environmentId)
    : undefined;

  return (
    <>
      <SettingsSection
        title={gt("Coordinator instructions")}
        footer={managedReason}
        trailing={
          pendingWrites > 0 ? null : source === "mixed" ? (
            <Text className="px-2 text-sm text-foreground-muted android:px-4">{gt("Mixed")}</Text>
          ) : source === "project" ? (
            <Text className="px-2 text-sm text-foreground-muted android:px-4">
              {gt("Overridden")}
            </Text>
          ) : null
        }
      >
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {gt("Delivered only to this project's designated coordinator thread.")}
          </Text>
          <AppTextInput
            key={`${targetsKey}:${source}:${instructions ?? "mixed"}`}
            accessibilityLabel={gt("Coordinator instructions")}
            onChangeText={(text) => {
              draft.current = { text, over: instructions, source };
            }}
            defaultValue={instructions ?? ""}
            placeholder={
              instructions === null
                ? gt("Mixed. Enter instructions to apply to all selected targets.")
                : undefined
            }
            editable={!disabled}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={commitDraft}
          />
          {hasOverride && pendingWrites === 0 ? (
            <View className="flex-row justify-end">
              <Button
                label={gt("Use default")}
                accessibilityHint={gt("Use inherited coordinator instructions")}
                tone="text"
                size="compact"
                disabled={disabled}
                onPress={() => {
                  draft.current = null;
                  runAction({ kind: "clear" });
                }}
              />
            </View>
          ) : null}
        </View>
      </SettingsSection>

      {singleMember && singleEnvironment ? (
        <CoordinatorThreadSection
          environmentId={singleMember.environmentId}
          projectId={singleMember.id}
          serverSettings={singleEnvironment.serverConfig.settings}
          canWrite={writableSettingsEnvironments.has(singleMember.environmentId)}
        />
      ) : null}
    </>
  );
}
