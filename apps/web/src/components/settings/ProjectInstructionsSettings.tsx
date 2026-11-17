import { useGT, useMessages } from "gt-react";
import { useRef } from "react";

import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettingSource,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function ProjectInstructionsRow() {
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const mixed = useScopedSettingsMixed(["projectInstructions"]);
  const source = useScopedSettingSource(["projectInstructions"]);
  const setting = searchableSetting("project-instructions");

  return (
    <SettingsRow
      serverScoped
      settingKeys={["projectInstructions"]}
      id={setting.id}
      title={m(setting.title)}
      description={gt("Shared with every thread in this project, whatever the provider.")}
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${source}:${settings.projectInstructions}`}
          aria-label={m(setting.title)}
          onChange={() => {
            edited.current = true;
          }}
          rows={4}
          defaultValue={mixed ? "" : settings.projectInstructions}
          placeholder={
            mixed ? gt("Mixed. Enter instructions to apply to all selected targets.") : undefined
          }
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (!edited.current) return;
            edited.current = false;
            if (value === "") {
              if (source === "project" || source === "mixed") {
                clearOverrides(["projectInstructions"]);
              } else if (settings.projectInstructions !== "") {
                event.currentTarget.value = settings.projectInstructions;
              }
              return;
            }
            if (mixed || value !== settings.projectInstructions) {
              updateSettings({ projectInstructions: value });
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}

export function ProjectInstructionsSettings() {
  if (useOptionalSettingsScope() === null) return null;
  return <ProjectInstructionsRow />;
}
