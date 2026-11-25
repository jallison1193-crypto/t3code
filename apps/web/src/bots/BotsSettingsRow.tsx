import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import { Switch } from "~/components/ui/switch";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

export function BotsSettingsRow() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { environments } = useEnvironments();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "bots enabled",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);

  const loadedEnvironments = environments.filter((env) => env.serverConfig !== null);
  const targetEnvironments = loadedEnvironments.filter(
    (env) => env.connection.phase === "connected" && writable.has(env.environmentId),
  );
  const states = loadedEnvironments.map((env) => env.serverConfig!.settings.botsEnabled !== false);
  const anyEnabled = states.length === 0 ? true : states.some(Boolean);
  const allEnabled = states.length === 0 ? true : states.every(Boolean);
  const mixed = states.length > 1 && anyEnabled && !allEnabled;

  const setBotsEnabled = async (next: boolean) => {
    if (saving || targetEnvironments.length === 0) return;
    setSaving(true);
    const results = await Promise.all(
      targetEnvironments.map((env) =>
        updateSettings({
          environmentId: env.environmentId,
          input: { patch: { botsEnabled: next } },
        }),
      ),
    );
    setSaving(false);
    for (const result of results) {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not update Bots setting"),
            description: failure instanceof Error ? failure.message : String(failure),
          }),
        );
        break;
      }
    }
  };

  return (
    <SettingsRow
      {...setting("bots-enabled")}
      description={
        <T>
          Show Bots in the sidebar and run their triggers, on all connected environments. Turning
          this off pauses every bot trigger without deleting bots.
        </T>
      }
      status={mixed ? gt("Mixed across connected environments") : undefined}
      resetAction={
        !allEnabled && targetEnvironments.length > 0 ? (
          <SettingResetButton
            ariaLabel={gt("Reset Bots to default")}
            onClick={() => void setBotsEnabled(true)}
          />
        ) : null
      }
      control={
        <Switch
          checked={anyEnabled}
          disabled={saving || targetEnvironments.length === 0}
          onCheckedChange={(checked) => void setBotsEnabled(Boolean(checked))}
          aria-label={gt("Bots")}
        />
      }
    />
  );
}
