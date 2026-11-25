import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { T, useGT } from "gt-react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";

export function BotModelPicker({
  environmentId,
  projectId,
  value,
  disabled = false,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: ModelSelection | null;
  readonly disabled?: boolean;
  readonly onChange: (next: ModelSelection | null) => void;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const activeInstanceId =
    value?.instanceId ??
    instanceEntries.find((entry) => entry.enabled)?.instanceId ??
    instanceEntries[0]?.instanceId ??
    ProviderInstanceId.make("codex");
  const activeModel = value?.model ?? "";
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  const activeProvider: ProviderDriverKind =
    activeEntry?.driverKind ?? ProviderDriverKind.make("codex");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProviderModelPicker
        environmentId={environmentId}
        disabled={disabled}
        activeInstanceId={activeInstanceId}
        model={activeModel}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        isComposerOwned={false}
        {...(value === null ? { triggerLabel: gt("Default model") } : {})}
        triggerAriaLabel={gt("Bot model")}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onInstanceModelChange={(instanceId, model) => {
          const sameModel = value?.instanceId === instanceId && value.model === model;
          onChange(createModelSelection(instanceId, model, sameModel ? value?.options : undefined));
        }}
      />
      {value !== null && activeEntry ? (
        <TraitsPicker
          provider={activeProvider}
          models={activeEntry.models}
          model={value.model}
          modelOptions={value.options}
          allowPromptInjectedEffort={false}
          disabled={disabled}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onModelOptionsChange={(nextOptions) =>
            onChange(createModelSelection(value.instanceId, value.model, nextOptions))
          }
        />
      ) : null}
      {value !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <T>Use default</T>
        </Button>
      ) : null}
    </div>
  );
}
