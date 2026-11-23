import type { InstalledPlugin } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function PluginsSettingsPanel() {
  const setting = useSearchableSetting();
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";

  return (
    <SettingsPageContainer>
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.environment.capabilities.environmentPlugins !== true ? (
        <SettingsSection {...setting("plugins")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>
              Update T3 Code on <Var>{environment.label}</Var> to manage its plugins.
            </T>
          </p>
        </SettingsSection>
      ) : connected ? (
        <EnvironmentPluginsSection key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...setting("plugins")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment to manage its plugins.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentPluginsSection({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const messages = useMessages();
  const environmentId = environment.environmentId;

  const pluginsQuery = useEnvironmentQuery(
    serverEnvironment.pluginsList({ environmentId, input: {} }),
    messages,
  );
  const livePluginSettings = useEnvironmentSettings(environmentId, (settings) => settings.plugins);
  const canSetEnabled = useAtomValue(
    serverEnvironment.setPluginEnabled.permissionAtom(environmentId),
  );
  const canUninstall = useAtomValue(
    serverEnvironment.uninstallPlugin.permissionAtom(environmentId),
  );
  const setPluginEnabled = useAtomCommand(serverEnvironment.setPluginEnabled, {
    label: "plugin enabled update",
    reportFailure: false,
  });
  const uninstallPlugin = useAtomCommand(serverEnvironment.uninstallPlugin, {
    label: "plugin uninstall",
    reportFailure: false,
  });

  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPlugin | null>(null);

  const plugins = pluginsQuery.data?.plugins ?? [];
  const pluginsDir = pluginsQuery.data?.pluginsDir ?? null;

  const handleToggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    setBusyPluginId(plugin.id);
    try {
      const result = await setPluginEnabled({
        environmentId,
        input: { id: plugin.id, enabled },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Plugin not updated"),
          description:
            (error instanceof Error ? thrownErrorMessage(error, messages) : null) ??
            gt("Could not update plugin state."),
        });
      }
    } finally {
      setBusyPluginId((current) => (current === plugin.id ? null : current));
    }
  };

  const handleConfirmUninstall = async (plugin: InstalledPlugin) => {
    setUninstallTarget(null);
    setBusyPluginId(plugin.id);
    try {
      const result = await uninstallPlugin({
        environmentId,
        input: { id: plugin.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Plugin not uninstalled"),
          description:
            (error instanceof Error ? thrownErrorMessage(error, messages) : null) ??
            gt("Could not uninstall plugin."),
        });
      }
    } finally {
      setBusyPluginId((current) => (current === plugin.id ? null : current));
    }
  };

  const uninstallLabel = uninstallTarget?.displayName ?? uninstallTarget?.id ?? "";

  return (
    <>
      <SettingsSection
        {...setting("plugins")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={pluginsQuery.isPending}
            onClick={() => pluginsQuery.refresh()}
          >
            <RefreshCwIcon className="size-3" aria-hidden />
            <T>Refresh</T>
          </Button>
        }
      >
        {pluginsQuery.error !== null && pluginsQuery.data === null ? (
          <SettingsRow
            title={gt("Could not load plugins")}
            description={pluginsQuery.error}
            control={
              <Button size="xs" variant="outline" onClick={() => pluginsQuery.refresh()}>
                <T>Retry</T>
              </Button>
            }
          />
        ) : pluginsQuery.data === null && pluginsQuery.isPending ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Loading plugins…</T>
          </p>
        ) : plugins.length === 0 ? (
          <div className="space-y-1.5 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              <T>
                Plugins live in the plugins folder below; agents will also be able to build them
                here soon.
              </T>
            </p>
            {pluginsDir ? (
              <p className="font-mono text-xs text-muted-foreground break-all select-text">
                {pluginsDir}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {plugins.map((plugin) => {
              const label = plugin.displayName ?? plugin.id;
              const hasProblem = plugin.problem !== undefined;
              const enabled =
                !hasProblem &&
                (Object.hasOwn(livePluginSettings, plugin.id)
                  ? livePluginSettings[plugin.id]?.enabled === true
                  : plugin.enabled);
              const busy = busyPluginId === plugin.id;
              return (
                <SettingsRow
                  key={plugin.id}
                  title={
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="min-w-0 wrap-anywhere">{label}</span>
                      {plugin.version ? (
                        <span className="text-xs font-normal text-muted-foreground">
                          {plugin.version}
                        </span>
                      ) : null}
                    </span>
                  }
                  description={plugin.description}
                  status={
                    hasProblem ? (
                      <span className="text-muted-foreground">{plugin.problem}</span>
                    ) : undefined
                  }
                  control={
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={enabled}
                        disabled={!canSetEnabled || hasProblem || busy}
                        onCheckedChange={(checked) => void handleToggle(plugin, Boolean(checked))}
                        aria-label={gt("Enable {name}", { name: label })}
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canUninstall || busy}
                        onClick={() => setUninstallTarget(plugin)}
                      >
                        <T>Uninstall</T>
                      </Button>
                    </div>
                  }
                />
              );
            })}
            {pluginsDir ? (
              <div className="px-4 py-2.5 text-xs text-muted-foreground">
                <T>
                  Plugins folder:{" "}
                  <span className="font-mono break-all select-text">
                    <Var>{pluginsDir}</Var>
                  </span>
                </T>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      <AlertDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Uninstall <Var>{uninstallLabel}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The plugin folder will be moved to{" "}
                <span className="font-mono text-xs">plugins-archive</span> and its enabled setting
                will be removed. You can restore it later by moving the folder back.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (uninstallTarget) void handleConfirmUninstall(uninstallTarget);
              }}
            >
              <T>Uninstall</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
