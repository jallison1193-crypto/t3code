import { useAtomValue } from "@effect/atom-react";
import {
  type BotApprovalsMode,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { T, useGT, useMessages } from "gt-react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import {
  formatBotGateUnsupportedReason,
  getBotModelDisabledReason,
  isBotEntryGateSupported,
  resolveBotEffectiveModelSelection,
} from "./bots.logic";

export function BotModelPicker({
  environmentId,
  projectId,
  value,
  approvals = "t3_gate",
  disabled = false,
  emptyLabel,
  showClearButton = true,
  warnOnInheritedUnsupported = true,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: ModelSelection | null;
  readonly approvals?: BotApprovalsMode;
  readonly disabled?: boolean;
  readonly emptyLabel?: string;
  readonly showClearButton?: boolean;
  readonly warnOnInheritedUnsupported?: boolean;
  readonly onChange: (next: ModelSelection | null) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const defaultFallbackEntry =
    (approvals === "provider"
      ? instanceEntries.find((entry) => entry.enabled && entry.isAvailable)
      : (instanceEntries.find(
          (entry) => entry.enabled && entry.isAvailable && isBotEntryGateSupported(entry),
        ) ?? instanceEntries.find((entry) => entry.enabled && isBotEntryGateSupported(entry)))) ??
    instanceEntries.find((entry) => entry.enabled) ??
    instanceEntries[0];
  const activeInstanceId =
    value?.instanceId ?? defaultFallbackEntry?.instanceId ?? ProviderInstanceId.make("codex");
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
  const effectiveModel = resolveBotEffectiveModelSelection({
    botModelSelection: value,
    environmentDefaultModelSelection: settings.defaultModelSelection,
    instanceEntries,
    approvals,
  });
  const showUnsupportedWarning =
    effectiveModel.unsupported && (value !== null || warnOnInheritedUnsupported);
  const unsupportedWarningText =
    effectiveModel.gateCapability.status === "unsupported"
      ? formatBotGateUnsupportedReason(effectiveModel.gateCapability.reasonCode, messages)
      : null;

  return (
    <div className="space-y-1.5">
      {showUnsupportedWarning && unsupportedWarningText !== null ? (
        <p className="text-xs text-warning" role="status">
          {unsupportedWarningText}
        </p>
      ) : null}
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
          getModelDisabledReason={(instanceId) => {
            const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
            return getBotModelDisabledReason(entry, approvals, messages);
          }}
          {...(value === null ? { triggerLabel: emptyLabel ?? gt("Default model") } : {})}
          triggerAriaLabel={gt("Bot model")}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onInstanceModelChange={(instanceId, model) => {
            const sameModel = value?.instanceId === instanceId && value.model === model;
            onChange(
              createModelSelection(instanceId, model, sameModel ? value?.options : undefined),
            );
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
        {showClearButton && value !== null ? (
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
    </div>
  );
}
