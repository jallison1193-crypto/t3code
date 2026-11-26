import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type BotLimitMode,
  type BotLimits,
  type EnvironmentId,
  isBotPaused,
  isBotProject,
  type ModelSelection,
  type ProjectId,
  resolveBotLimits,
  type ServerSettings,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Equal from "effect/Equal";
import { T, useGT, useMessages } from "gt-react";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { BotLimitModeSelect, BotLimitNumberInputs } from "./BotLimitsControls";
import { BotModelPicker } from "./BotModelPicker";
import { BotSettingsPanel } from "./BotSettingsPanel";
import { BotsSettingsRow } from "./BotsSettingsRow";
import {
  formatBotModelDisplayName,
  formatBotTodayUsage,
  isBotEnvironmentEnabled,
  parseBotPositiveInt,
  resolveBotEffectiveModelSelection,
  resolveBotListStatus,
} from "./bots.logic";
import { openNewBotDialog } from "./newBotDialogState";
import { useBotWritableEnvironments } from "./useBots";

interface BotSettingsListEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId: ProjectId;
  readonly projectKey: string;
  readonly name: string;
  readonly settings: ServerSettings;
  readonly paused: boolean;
}

export function BotsSettingsPage({
  selectedBotId,
  selectedEnvironmentId,
}: {
  readonly selectedBotId?: ProjectId | undefined;
  readonly selectedEnvironmentId?: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const setting = useSearchableSetting();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const projects = useProjects();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const botWritableEnvironments = useBotWritableEnvironments();
  const canCreateBot = botWritableEnvironments.length > 0;

  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "bot defaults",
    reportFailure: false,
  });

  const [savingModel, setSavingModel] = useState(false);
  const [savingLimits, setSavingLimits] = useState(false);

  const loadedEnvironments = environments.filter((env) => env.serverConfig !== null);
  const targetEnvironments = loadedEnvironments.filter(
    (env) => env.connection.phase === "connected" && writable.has(env.environmentId),
  );
  const displayEnvironment =
    targetEnvironments.find((env) => env.environmentId === primaryEnvironmentId) ??
    targetEnvironments[0] ??
    loadedEnvironments.find((env) => env.environmentId === primaryEnvironmentId) ??
    loadedEnvironments[0] ??
    null;

  const defaultModels = loadedEnvironments.map(
    (env) => env.serverConfig?.settings.botDefaults?.modelSelection ?? null,
  );
  const displayModel =
    displayEnvironment?.serverConfig?.settings.botDefaults?.modelSelection ?? null;
  const anyCustomModel = defaultModels.some((model) => model !== null);
  const mixedModel =
    defaultModels.length > 1 &&
    defaultModels.some((model) => !Equal.equals(model, defaultModels[0]));

  const resolvedLimitsByEnv = loadedEnvironments.map((env) =>
    resolveBotLimits({ limits: env.serverConfig?.settings.botDefaults?.limits }),
  );
  const displayLimits = resolveBotLimits({
    limits: displayEnvironment?.serverConfig?.settings.botDefaults?.limits,
  });
  const anyCustomLimits = loadedEnvironments.some(
    (env) => env.serverConfig?.settings.botDefaults?.limits !== undefined,
  );
  const mixedLimits =
    resolvedLimitsByEnv.length > 1 &&
    resolvedLimitsByEnv.some((limits) => !Equal.equals(limits, resolvedLimitsByEnv[0]));

  const savedLimitsKey = `${displayLimits.mode}:${displayLimits.runsPerDay}:${displayLimits.tokensPerDay}`;
  const [limitsDraft, setLimitsDraft] = useState<{
    readonly key: string;
    readonly runsText?: string;
    readonly tokensText?: string;
  }>(() => ({ key: savedLimitsKey }));
  const currentLimitsDraft =
    limitsDraft.key === savedLimitsKey ? limitsDraft : { key: savedLimitsKey };
  const draftRunsText = currentLimitsDraft.runsText ?? String(displayLimits.runsPerDay);
  const draftTokensText = currentLimitsDraft.tokensText ?? String(displayLimits.tokensPerDay);
  const parsedRuns = parseBotPositiveInt(draftRunsText);
  const parsedTokens = parseBotPositiveInt(draftTokensText);
  const limitsInvalid =
    (displayLimits.mode !== "none" && parsedRuns === null) ||
    (displayLimits.mode === "runs_and_tokens" && parsedTokens === null);
  const hasLocalLimitsDraft =
    currentLimitsDraft.runsText !== undefined || currentLimitsDraft.tokensText !== undefined;

  const environmentsById = new Map(environments.map((env) => [env.environmentId, env]));
  const botEntries: BotSettingsListEntry[] = [];
  for (const project of projects) {
    if (project.archivedAt !== null) continue;
    const env = environmentsById.get(project.environmentId);
    if (!env || env.connection.phase !== "connected" || env.serverConfig === null) continue;
    const envSettings = env.serverConfig.settings;
    if (!isBotProject(envSettings, project.id)) continue;
    botEntries.push({
      environmentId: project.environmentId,
      environmentLabel: env.label,
      projectId: project.id,
      projectKey: derivePhysicalProjectKey(project),
      name: project.title,
      settings: envSettings,
      paused: isBotPaused(envSettings, project.id),
    });
  }
  botEntries.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.environmentLabel.localeCompare(right.environmentLabel),
  );
  const showEnvironmentName = new Set(botEntries.map((entry) => entry.environmentId)).size > 1;

  const reportError = (title: string, error: unknown) => {
    const description =
      error instanceof Error
        ? (thrownErrorMessage(error, messages) ?? error.message)
        : String(error);
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  };

  const saveDefaultModel = async (next: ModelSelection | null) => {
    if (savingModel || targetEnvironments.length === 0) return;
    setSavingModel(true);
    const results = await Promise.all(
      targetEnvironments.map((env) =>
        updateSettings({
          environmentId: env.environmentId,
          input: { patch: { botDefaults: { modelSelection: next } } },
        }),
      ),
    );
    setSavingModel(false);
    for (const result of results) {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportError(gt("Could not update default bot model"), squashAtomCommandFailure(result));
        break;
      }
    }
  };

  const saveDefaultLimits = async (next: BotLimits | null) => {
    if (savingLimits || targetEnvironments.length === 0) return;
    setSavingLimits(true);
    const results = await Promise.all(
      targetEnvironments.map((env) =>
        updateSettings({
          environmentId: env.environmentId,
          input: { patch: { botDefaults: { limits: next } } },
        }),
      ),
    );
    setSavingLimits(false);
    for (const result of results) {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportError(gt("Could not update default daily limits"), squashAtomCommandFailure(result));
        return;
      }
    }
    setLimitsDraft({ key: savedLimitsKey });
  };

  const handleDefaultLimitModeChange = (mode: BotLimitMode) => {
    const runsPerDay = parsedRuns ?? displayLimits.runsPerDay;
    const tokensPerDay = parsedTokens ?? displayLimits.tokensPerDay;
    const next: BotLimits =
      mode === "none"
        ? { mode: "none" }
        : mode === "runs_only"
          ? { mode: "runs_only", runsPerDay }
          : { mode: "runs_and_tokens", runsPerDay, tokensPerDay };
    void saveDefaultLimits(next);
  };

  const commitDefaultLimitNumbers = () => {
    if (displayLimits.mode === "none") return;
    if (parsedRuns === null) return;
    if (displayLimits.mode === "runs_and_tokens" && parsedTokens === null) return;
    const unchanged =
      parsedRuns === displayLimits.runsPerDay &&
      (displayLimits.mode !== "runs_and_tokens" || parsedTokens === displayLimits.tokensPerDay);
    if (unchanged) {
      setLimitsDraft({ key: savedLimitsKey });
      return;
    }
    const next: BotLimits =
      displayLimits.mode === "runs_only"
        ? { mode: "runs_only", runsPerDay: parsedRuns }
        : {
            mode: "runs_and_tokens",
            runsPerDay: parsedRuns,
            tokensPerDay: parsedTokens ?? displayLimits.tokensPerDay,
          };
    void saveDefaultLimits(next);
  };

  if (selectedBotId !== undefined) {
    const selectedBot =
      botEntries.find(
        (entry) =>
          entry.projectId === selectedBotId &&
          (selectedEnvironmentId === undefined || entry.environmentId === selectedEnvironmentId),
      ) ?? null;

    return (
      <SettingsPageContainer>
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void navigate({ to: "/settings/bots", search: {} })}
          >
            <ArrowLeftIcon className="size-3.5" />
            <T>Back to all bots</T>
          </Button>
          {selectedBot !== null ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() =>
                void navigate({
                  to: "/projects/$projectKey",
                  params: { projectKey: selectedBot.projectKey },
                })
              }
            >
              <ExternalLinkIcon className="size-3.5" />
              <T>Open bot page</T>
            </Button>
          ) : null}
        </div>

        {selectedBot === null ? (
          <SettingsSection title={gt("Bot settings")}>
            {!environmentsReady ? (
              <SettingsRow title={gt("Loading bot…")} role="status" />
            ) : (
              <SettingsRow
                title={gt("Bot not found")}
                description={gt("This bot could not be found in your connected environments.")}
              />
            )}
          </SettingsSection>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4">
              <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              <h2 className="truncate text-base font-semibold text-foreground">
                {selectedBot.name}
              </h2>
              {showEnvironmentName ? (
                <Badge variant="secondary" size="sm">
                  {selectedBot.environmentLabel}
                </Badge>
              ) : null}
              {selectedBot.paused ? (
                <Badge variant="outline" size="sm">
                  <T>Paused</T>
                </Badge>
              ) : null}
            </div>
            <BotSettingsPanel
              botKey={`${selectedBot.environmentId}:${selectedBot.projectId}`}
              environmentId={selectedBot.environmentId}
              projectId={selectedBot.projectId}
              savedName={selectedBot.name}
            />
          </div>
        )}
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="bots" title={gt("Bots")}>
        <BotsSettingsRow />

        <SettingsRow
          {...setting("bot-default-model")}
          description={
            <T>Model assigned to new bots. Changing this does not affect existing bots.</T>
          }
          status={mixedModel ? gt("Mixed across connected environments") : undefined}
          resetAction={
            anyCustomModel && targetEnvironments.length > 0 ? (
              <SettingResetButton
                ariaLabel={gt("Reset default model for new bots to automatic")}
                disabled={savingModel}
                onClick={() => void saveDefaultModel(null)}
              />
            ) : null
          }
          control={
            displayEnvironment !== null ? (
              <BotModelPicker
                environmentId={displayEnvironment.environmentId}
                projectId={null}
                value={displayModel}
                disabled={savingModel || targetEnvironments.length === 0}
                emptyLabel={gt("Automatic")}
                showClearButton={false}
                warnOnInheritedUnsupported={false}
                onChange={(next) => void saveDefaultModel(next)}
              />
            ) : (
              <span className="text-xs text-muted-foreground">
                <T>Automatic</T>
              </span>
            )
          }
        />

        <SettingsRow
          {...setting("bot-default-limits")}
          description={
            <T>
              Daily run and token caps copied to new bots. Changing this does not affect existing
              bots.
            </T>
          }
          status={
            mixedLimits
              ? gt("Mixed across connected environments")
              : limitsInvalid
                ? gt("Daily limits must be positive whole numbers.")
                : undefined
          }
          resetAction={
            (anyCustomLimits || hasLocalLimitsDraft) && targetEnvironments.length > 0 ? (
              <SettingResetButton
                ariaLabel={gt("Reset default daily limits for new bots")}
                disabled={savingLimits}
                onClick={() => {
                  setLimitsDraft({ key: savedLimitsKey });
                  if (anyCustomLimits) void saveDefaultLimits(null);
                }}
              />
            ) : null
          }
          control={
            <BotLimitModeSelect
              value={displayLimits.mode}
              disabled={savingLimits || targetEnvironments.length === 0}
              ariaLabel={gt("Default daily limits for new bots")}
              onChange={handleDefaultLimitModeChange}
            />
          }
        >
          <BotLimitNumberInputs
            idPrefix="bot-defaults"
            mode={displayLimits.mode}
            disabled={savingLimits || targetEnvironments.length === 0}
            runsText={draftRunsText}
            tokensText={draftTokensText}
            onRunsChange={(value) => setLimitsDraft({ ...currentLimitsDraft, runsText: value })}
            onTokensChange={(value) => setLimitsDraft({ ...currentLimitsDraft, tokensText: value })}
            onCommit={commitDefaultLimitNumbers}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        {...setting("bots-list")}
        headerAction={
          botEntries.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!canCreateBot}
              onClick={() => openNewBotDialog()}
            >
              <PlusIcon className="size-3.5" />
              <T>New bot</T>
            </Button>
          ) : undefined
        }
      >
        {botEntries.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>No bots yet</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Create a bot to run on a schedule or webhook with its own goal and limits.</T>
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                size="sm"
                disabled={!canCreateBot}
                onClick={() => openNewBotDialog()}
              >
                <PlusIcon className="size-3.5" />
                <T>New bot</T>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          botEntries.map((entry) => (
            <BotSettingsListRow
              key={`${entry.environmentId}:${entry.projectId}`}
              entry={entry}
              showEnvironmentName={showEnvironmentName}
              onSelect={() =>
                void navigate({
                  to: "/settings/bots",
                  search: { bot: entry.projectId, env: entry.environmentId },
                })
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BotSettingsListRow({
  entry,
  showEnvironmentName,
  onSelect,
}: {
  readonly entry: BotSettingsListEntry;
  readonly showEnvironmentName: boolean;
  readonly onSelect: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { environmentId, projectId, settings, paused } = entry;
  const botsEnabled = isBotEnvironmentEnabled(settings);
  const overrides = settings.projectSettingsOverrides[projectId];
  const savedLimits = resolveBotLimits(overrides?.bot);
  const canUpdateBot = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const effectiveModel = resolveBotEffectiveModelSelection({
    botModelSelection: overrides?.defaultModelSelection ?? null,
    environmentDefaultModelSelection: settings.defaultModelSelection,
    instanceEntries,
  });
  const modelName = formatBotModelDisplayName(effectiveModel.selection, instanceEntries);

  const usageQuery = useEnvironmentQuery(
    serverEnvironment.botUsage({ environmentId, input: { projectId } }),
    messages,
  );
  const todaySummary = formatBotTodayUsage(usageQuery.data?.usage, savedLimits, messages);
  const status = resolveBotListStatus(
    {
      botsEnabled,
      paused,
      blockedByPolicy: usageQuery.data?.blockedByPolicy,
    },
    messages,
  );
  const statusBadgeVariant =
    status.kind === "active" ? "success" : status.kind === "paused" ? "outline" : "warning";

  const updateBot = useAtomCommand(serverEnvironment.updateBot, {
    label: "bot pause",
    reportFailure: false,
  });
  const [togglingPause, setTogglingPause] = useState(false);

  const handleTogglePause = async () => {
    if (togglingPause || !canUpdateBot || !botsEnabled) return;
    setTogglingPause(true);
    const result = await updateBot({
      environmentId,
      input: {
        projectId,
        paused: !paused,
      },
    });
    setTogglingPause(false);
    usageQuery.refresh();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: paused ? gt("Could not resume bot") : gt("Could not pause bot"),
          description:
            failure instanceof Error
              ? (thrownErrorMessage(failure, messages) ?? failure.message)
              : String(failure),
        }),
      );
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-xl pr-3 transition-colors hover:bg-accent/50 sm:pr-4">
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
      >
        <BotIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
            <Badge variant={statusBadgeVariant} size="sm">
              {status.label}
            </Badge>
            {showEnvironmentName ? (
              <Badge variant="secondary" size="sm">
                {entry.environmentLabel}
              </Badge>
            ) : null}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{modelName ?? gt("Default model")}</span>
            {todaySummary !== null ? <span>{todaySummary}</span> : null}
          </span>
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {canUpdateBot ? (
        <div className="shrink-0">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!botsEnabled || togglingPause}
            onClick={() => void handleTogglePause()}
          >
            {paused ? (
              <>
                <PlayIcon className="size-3.5" />
                <T>Resume</T>
              </>
            ) : (
              <>
                <PauseIcon className="size-3.5" />
                <T>Pause</T>
              </>
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
