import {
  buildCoordinatorPatch,
  coordinatorThreadIdOf,
} from "@t3tools/client-runtime/coordinator-thread";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";

import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettingSource,
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function CoordinatorInstructionsRow() {
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const mixed = useScopedSettingsMixed(["coordinatorInstructions"]);
  const source = useScopedSettingSource(["coordinatorInstructions"]);
  const setting = searchableSetting("coordinator-instructions");

  return (
    <SettingsRow
      serverScoped
      settingKeys={["coordinatorInstructions"]}
      id={setting.id}
      title={m(setting.title)}
      description={gt("Delivered only to this project's designated coordinator thread.")}
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${source}:${settings.coordinatorInstructions}`}
          aria-label={m(setting.title)}
          onChange={() => {
            edited.current = true;
          }}
          rows={4}
          defaultValue={mixed ? "" : settings.coordinatorInstructions}
          placeholder={
            mixed ? gt("Mixed. Enter instructions to apply to all selected targets.") : undefined
          }
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (!edited.current) return;
            edited.current = false;
            if (value === "") {
              if (source === "project" || source === "mixed") {
                clearOverrides(["coordinatorInstructions"]);
              } else if (settings.coordinatorInstructions !== "") {
                event.currentTarget.value = settings.coordinatorInstructions;
              }
              return;
            }
            if (mixed || value !== settings.coordinatorInstructions) {
              updateSettings({ coordinatorInstructions: value });
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}

function CoordinatorThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const { connectedEnvironments } = useSettingsScope();
  const canWrite = useScopedSettingsWriteAllowed();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const [isClearing, setIsClearing] = useState(false);

  const serverSettings = connectedEnvironments.find(
    (environment) => environment.environmentId === props.environmentId,
  )?.serverConfig?.settings;
  const coordinatorThreadId = coordinatorThreadIdOf(serverSettings, props.projectId);
  const thread = useThreadShell(
    coordinatorThreadId === null ? null : scopeThreadRef(props.environmentId, coordinatorThreadId),
  );

  const description =
    coordinatorThreadId === null ? gt("None") : (thread?.title ?? gt("Thread not found"));

  const handleClear = () => {
    if (!serverSettings || coordinatorThreadId === null || isClearing) return;
    setIsClearing(true);
    void updateSettings({
      environmentId: props.environmentId,
      input: { patch: buildCoordinatorPatch(serverSettings, props.projectId, null) },
    }).finally(() => {
      setIsClearing(false);
    });
  };

  return (
    <SettingsRow
      id="coordinator-thread"
      title={gt("Coordinator thread")}
      description={description}
      control={
        coordinatorThreadId !== null ? (
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={!canWrite || isClearing}
            onClick={handleClear}
          >
            {gt("Clear")}
          </Button>
        ) : undefined
      }
    />
  );
}

function CoordinatorSettingsContent() {
  const { scope, targets } = useSettingsScope();
  const singleTarget =
    (scope.kind === "project" || scope.kind === "checkout") &&
    scope.members.length === 1 &&
    targets.length === 1 &&
    targets[0]?.projectId != null
      ? { environmentId: targets[0].environmentId, projectId: targets[0].projectId }
      : null;

  return (
    <>
      <CoordinatorInstructionsRow />
      {singleTarget ? (
        <CoordinatorThreadRow
          environmentId={singleTarget.environmentId}
          projectId={singleTarget.projectId}
        />
      ) : null}
    </>
  );
}

export function CoordinatorSettings() {
  if (useOptionalSettingsScope() === null) return null;
  return <CoordinatorSettingsContent />;
}
