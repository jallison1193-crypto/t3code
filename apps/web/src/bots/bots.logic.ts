import {
  BOT_DAILY_RUN_LIMIT_REASON,
  BOT_DAILY_TOKEN_LIMIT_REASON,
  BOT_PAUSED_REASON,
  BOT_UNSUPPORTED_PROVIDER_REASON,
  BOTS_DISABLED_REASON,
  DEFAULT_MODEL_BY_PROVIDER,
  botGateUnsupportedFallbackReason,
  isBotPaused,
  isBotProject,
  isListedThreadLineage,
  resolveBotGateCapability,
  resolveSidebarModeFilter,
  type BotApprovalsMode,
  type BotBlockReasonCode,
  type BotDailyUsage,
  type BotGateCapability,
  type BotGateUnsupportedReasonCode,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ResolvedBotLimits,
  type ServerSettings,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { SidebarModeFilter } from "@t3tools/contracts/settings";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import * as Predicate from "effect/Predicate";
import { msg } from "gt-react";

import { getDisplayModelName } from "../components/chat/providerIconUtils";
import type {
  ProjectsSidebarGroupInput,
  ProjectsSidebarThread,
} from "../components/sidebar/ProjectsSidebar.logic";
import { m, type MessageResolver } from "../i18n/messages";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

import {
  filterNonBotProjects,
  type BotServerSettingsLike,
  type BotSettingsLookup,
} from "./botProjectFilter";

export { filterNonBotProjects, type BotSettingsLookup };

export function isAnyBotsEnabled(
  environments: ReadonlyArray<{
    readonly serverConfig?: {
      readonly settings?: { readonly botsEnabled?: boolean | undefined } | undefined;
    } | null;
  }>,
): boolean {
  return environments.some(
    (environment) =>
      environment.serverConfig != null && environment.serverConfig.settings?.botsEnabled !== false,
  );
}

export function isBotEnvironmentEnabled(
  settings: { readonly botsEnabled?: boolean | undefined } | null | undefined,
): boolean {
  return settings != null && settings.botsEnabled !== false;
}

export function isBotProjectGroup(
  group: Pick<ProjectsSidebarGroupInput, "memberProjects">,
  getServerSettings: BotSettingsLookup,
): boolean {
  return (
    group.memberProjects.length > 0 &&
    group.memberProjects.every((member) =>
      isBotProject(getServerSettings(member.environmentId), member.id),
    )
  );
}

export function isBotThreadVisibleInNeedsYou(
  settings: BotServerSettingsLike,
  projectId: ProjectId,
): boolean {
  if (!isBotProject(settings, projectId)) return true;
  return isBotEnvironmentEnabled(settings);
}

// A bot folder can sit inside a repository; repository grouping would merge it with that repo's project.
export function keepBotProjectsSeparate(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>,
  overrides: Record<string, SidebarProjectGroupingMode>,
  getServerSettings: BotSettingsLookup,
): Record<string, SidebarProjectGroupingMode> {
  const botProjects = projects.filter((project) =>
    isBotProject(getServerSettings(project.environmentId), project.id),
  );
  if (botProjects.length === 0) return overrides;
  const next = { ...overrides };
  for (const project of botProjects) next[derivePhysicalProjectKey(project)] = "separate";
  return next;
}

export function filterNonBotThreads<
  TThread extends { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
>(threads: ReadonlyArray<TThread>, getServerSettings: BotSettingsLookup): ReadonlyArray<TThread> {
  return threads.filter(
    (thread) => !isBotProject(getServerSettings(thread.environmentId), thread.projectId),
  );
}

export interface BotSidebarEntry<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
> {
  readonly group: TGroup;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly paused: boolean;
  readonly runThreads: ReadonlyArray<TThread>;
}

function compareThreadsNewestFirst(
  a: Pick<ProjectsSidebarThread, "updatedAt">,
  b: Pick<ProjectsSidebarThread, "updatedAt">,
): number {
  return (toSortableTimestamp(b.updatedAt) ?? 0) - (toSortableTimestamp(a.updatedAt) ?? 0);
}

export function deriveBotSidebarEntries<
  TGroup extends ProjectsSidebarGroupInput,
  TThread extends ProjectsSidebarThread,
>(input: {
  readonly projectGroups: ReadonlyArray<TGroup>;
  readonly threads: ReadonlyArray<TThread>;
  readonly getServerSettings: BotSettingsLookup;
}): ReadonlyArray<BotSidebarEntry<TGroup, TThread>> {
  const listedThreads = input.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        isListedThreadLineage(thread.lineage),
    )
    .toSorted(compareThreadsNewestFirst);

  const entries: BotSidebarEntry<TGroup, TThread>[] = [];
  for (const group of input.projectGroups) {
    if (group.archived || !isBotProjectGroup(group, input.getServerSettings)) continue;
    const primary = group.memberProjects[0];
    if (!primary) continue;
    const settings = input.getServerSettings(primary.environmentId);
    if (!isBotEnvironmentEnabled(settings)) continue;
    const memberKeys = new Set(
      group.memberProjects.map((member) => `${member.environmentId}:${member.id}`),
    );
    const runThreads = listedThreads.filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    entries.push({
      group,
      environmentId: primary.environmentId,
      projectId: primary.id,
      name: group.displayName,
      paused: isBotPaused(settings, primary.id),
      runThreads,
    });
  }
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
}

export function formatBotTokenCount(tokens: number): string {
  const safe = Math.max(0, Math.trunc(tokens));
  if (safe >= 1_000_000) {
    const millions = safe / 1_000_000;
    const formatted =
      millions >= 10 || Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1);
    return `${formatted.replace(/\.0$/, "")}M`;
  }
  if (safe >= 1_000) {
    const thousands = safe / 1_000;
    const formatted =
      thousands >= 10 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1);
    return `${formatted.replace(/\.0$/, "")}k`;
  }
  return String(safe);
}

export function parseBotPositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function pickEntryDefaultModelSlug(entry: ProviderInstanceEntry): string | null {
  return (
    entry.models.find((model) => model.isDefault && !model.isLegacy && !model.isCustom)?.slug ??
    entry.models.find((model) => model.isDefault && !model.isLegacy)?.slug ??
    entry.models.find((model) => !model.isLegacy && !model.isCustom)?.slug ??
    entry.models.find((model) => !model.isLegacy)?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind] ??
    null
  );
}

export interface BotEffectiveModelResolution {
  readonly selection: ModelSelection | null;
  readonly source: "bot" | "default" | "fallback" | "none";
  readonly driverKind: ProviderDriverKind | null;
  readonly gateCapability: BotGateCapability;
  readonly unsupported: boolean;
}

export function isBotEntryGateSupported(entry: ProviderInstanceEntry): boolean {
  return resolveBotGateCapability(entry.snapshot).status === "supported";
}

export function getBotModelDisabledReason(
  entry: ProviderInstanceEntry | undefined,
  approvals: BotApprovalsMode = "t3_gate",
  resolve: (message: string) => string = m,
): string | null {
  if (approvals === "provider" || entry === undefined) return null;
  const capability = resolveBotGateCapability(entry.snapshot);
  return capability.status === "unsupported"
    ? formatBotGateUnsupportedReason(capability.reasonCode, resolve)
    : null;
}

export function resolveBotEffectiveModelSelection(input: {
  readonly botModelSelection: ModelSelection | null | undefined;
  readonly environmentDefaultModelSelection: ModelSelection | null | undefined;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly approvals?: BotApprovalsMode | undefined;
}): BotEffectiveModelResolution {
  let selection: ModelSelection | null = null;
  let source: BotEffectiveModelResolution["source"] = "none";

  if (input.botModelSelection != null) {
    selection = input.botModelSelection;
    source = "bot";
  } else if (input.environmentDefaultModelSelection != null) {
    selection = input.environmentDefaultModelSelection;
    source = "default";
  } else {
    const firstDriverKind = input.instanceEntries[0]?.driverKind;
    const fallbackEntry =
      (firstDriverKind === undefined
        ? undefined
        : resolveSelectableProviderInstanceEntry(
            input.instanceEntries.filter((candidate) => candidate.driverKind === firstDriverKind),
            undefined,
          )) ?? resolveSelectableProviderInstanceEntry(input.instanceEntries, undefined);
    const fallbackModel = fallbackEntry ? pickEntryDefaultModelSlug(fallbackEntry) : null;
    if (fallbackEntry && fallbackModel) {
      selection = { instanceId: fallbackEntry.instanceId, model: fallbackModel };
      source = "fallback";
    }
  }

  const entry =
    selection !== null
      ? input.instanceEntries.find((candidate) => candidate.instanceId === selection.instanceId)
      : undefined;
  const driverKind = entry?.driverKind ?? null;
  const gateCapability = resolveBotGateCapability(entry?.snapshot);
  const approvals = input.approvals ?? "t3_gate";
  const unsupported =
    entry !== undefined && approvals !== "provider" && gateCapability.status === "unsupported";

  return { selection, source, driverKind, gateCapability, unsupported };
}

export function resolveFirstSupportedBotModelSelection(
  settings:
    | (Pick<ServerSettings, "defaultModelSelection"> & {
        readonly botDefaults?: ServerSettings["botDefaults"];
      })
    | null
    | undefined,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ModelSelection | null {
  const readySupported = instanceEntries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated" &&
      isBotEntryGateSupported(entry),
  );
  const fallbackSupported = instanceEntries.filter(
    (entry) => entry.enabled && entry.isAvailable && isBotEntryGateSupported(entry),
  );
  const pool = readySupported.length > 0 ? readySupported : fallbackSupported;
  if (pool.length === 0) return null;

  const botDefault = settings?.botDefaults?.modelSelection ?? null;
  if (
    botDefault !== null &&
    fallbackSupported.some((entry) => entry.instanceId === botDefault.instanceId)
  ) {
    return botDefault;
  }

  const envDefault = settings?.defaultModelSelection ?? null;
  if (envDefault !== null) {
    const matchingEntry = pool.find((entry) => entry.instanceId === envDefault.instanceId);
    if (
      matchingEntry !== undefined &&
      matchingEntry.models.find((model) => model.slug === envDefault.model)?.isLegacy !== true
    ) {
      return envDefault;
    }
  }

  for (const entry of pool) {
    const slug = pickEntryDefaultModelSlug(entry);
    if (slug !== null) {
      return { instanceId: entry.instanceId, model: slug };
    }
  }
  return null;
}

export function formatBotModelDisplayName(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): string | null {
  if (selection === null) return null;
  const entry = instanceEntries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  return model ? getDisplayModelName(model) : selection.model;
}

export type BotRunNowDisabledReason =
  | "bots_off"
  | "paused"
  | "disconnected"
  | "no_permission"
  | "unsaved"
  | "blocked";

export function resolveBotRunNowState(input: {
  readonly botsEnabled: boolean;
  readonly paused: boolean;
  readonly connected: boolean;
  readonly canOperate: boolean;
  /** Unsaved edits: a run would use the goal and model from before them. */
  readonly dirty: boolean;
  /** The server's own refusal, such as a daily limit. */
  readonly blockedByPolicy: string | undefined;
}): { readonly disabled: boolean; readonly reason: BotRunNowDisabledReason | null } {
  if (!input.botsEnabled) return { disabled: true, reason: "bots_off" };
  if (input.paused) return { disabled: true, reason: "paused" };
  if (!input.connected) return { disabled: true, reason: "disconnected" };
  if (!input.canOperate) return { disabled: true, reason: "no_permission" };
  if (input.dirty) return { disabled: true, reason: "unsaved" };
  if (input.blockedByPolicy !== undefined) return { disabled: true, reason: "blocked" };
  return { disabled: false, reason: null };
}

export function isBotSidebarRoute(input: {
  readonly activeProjectKey: string | null;
  readonly activeThreadProject: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  } | null;
  readonly projectGroups: ReadonlyArray<
    Pick<ProjectsSidebarGroupInput, "projectKey" | "memberProjects">
  >;
  readonly getServerSettings: BotSettingsLookup;
}): boolean {
  if (input.activeProjectKey !== null) {
    const group = input.projectGroups.find(
      (candidate) => candidate.projectKey === input.activeProjectKey,
    );
    if (group !== undefined && isBotProjectGroup(group, input.getServerSettings)) {
      return true;
    }
  }
  if (input.activeThreadProject !== null) {
    return isBotProject(
      input.getServerSettings(input.activeThreadProject.environmentId),
      input.activeThreadProject.projectId,
    );
  }
  return false;
}

export function resolveBotRouteSidebarMode(input: {
  readonly savedMode: SidebarModeFilter;
  readonly botsEnabled: boolean;
  readonly isBotRoute: boolean;
  readonly routeOverride: SidebarModeFilter | null;
}): SidebarModeFilter {
  if (input.routeOverride !== null) {
    return resolveSidebarModeFilter(input.routeOverride, input.botsEnabled);
  }
  if (input.isBotRoute && input.botsEnabled) {
    return "bots";
  }
  return resolveSidebarModeFilter(input.savedMode, input.botsEnabled);
}

const BOT_GATE_UNSUPPORTED_REASON_LABELS: Readonly<Record<BotGateUnsupportedReasonCode, string>> = {
  no_approval_callback: msg(
    "This provider does not support interactive tool approvals for T3's bot safety gate.",
  ),
  ungated_mcp_or_tools: msg(
    "This provider can run some tools or MCP calls without T3's bot safety gate.",
  ),
  unisolated_user_rules: msg(
    "This provider can apply user or workspace rules that bypass T3's bot safety gate.",
  ),
  opaque_subagents_or_mcp: msg(
    "This provider runs subagents or profile MCP servers outside T3's bot safety gate.",
  ),
  unverified_third_party_acp: msg("This provider has not been verified for T3's bot safety gate."),
  provider_unavailable: msg("This bot's provider is not available."),
};

export function formatBotGateUnsupportedReason(
  reasonCode: BotGateUnsupportedReasonCode,
  resolve: (message: string) => string = m,
): string {
  return resolve(BOT_GATE_UNSUPPORTED_REASON_LABELS[reasonCode]);
}

const BOT_BLOCK_REASON_CODE_LABELS: Readonly<Record<BotBlockReasonCode, string>> = {
  bots_disabled: msg("Bots are turned off in Settings"),
  paused: msg("This bot is paused"),
  daily_run_limit: msg("Daily run limit reached"),
  daily_token_limit: msg("Daily token limit reached"),
  ...BOT_GATE_UNSUPPORTED_REASON_LABELS,
};

const BOT_BLOCK_REASON_LABELS: Readonly<Record<string, string>> = {
  [BOTS_DISABLED_REASON]: BOT_BLOCK_REASON_CODE_LABELS.bots_disabled,
  [BOT_PAUSED_REASON]: BOT_BLOCK_REASON_CODE_LABELS.paused,
  [BOT_DAILY_RUN_LIMIT_REASON]: BOT_BLOCK_REASON_CODE_LABELS.daily_run_limit,
  [BOT_DAILY_TOKEN_LIMIT_REASON]: BOT_BLOCK_REASON_CODE_LABELS.daily_token_limit,
  [BOT_UNSUPPORTED_PROVIDER_REASON]: msg("This provider is not supported for bots."),
  [botGateUnsupportedFallbackReason("no_approval_callback")]:
    BOT_GATE_UNSUPPORTED_REASON_LABELS.no_approval_callback,
  [botGateUnsupportedFallbackReason("ungated_mcp_or_tools")]:
    BOT_GATE_UNSUPPORTED_REASON_LABELS.ungated_mcp_or_tools,
  [botGateUnsupportedFallbackReason("unisolated_user_rules")]:
    BOT_GATE_UNSUPPORTED_REASON_LABELS.unisolated_user_rules,
  [botGateUnsupportedFallbackReason("opaque_subagents_or_mcp")]:
    BOT_GATE_UNSUPPORTED_REASON_LABELS.opaque_subagents_or_mcp,
  [botGateUnsupportedFallbackReason("unverified_third_party_acp")]:
    BOT_GATE_UNSUPPORTED_REASON_LABELS.unverified_third_party_acp,
  [botGateUnsupportedFallbackReason("provider_unavailable")]:
    BOT_GATE_UNSUPPORTED_REASON_LABELS.provider_unavailable,
};

export function formatBotBlockReason(
  reason: string,
  resolve: (message: string) => string = m,
  reasonCode?: BotBlockReasonCode | undefined,
): string {
  if (reasonCode !== undefined && Object.hasOwn(BOT_BLOCK_REASON_CODE_LABELS, reasonCode)) {
    return resolve(BOT_BLOCK_REASON_CODE_LABELS[reasonCode]);
  }
  if (!Object.hasOwn(BOT_BLOCK_REASON_LABELS, reason)) return reason;
  const label = BOT_BLOCK_REASON_LABELS[reason];
  return label === undefined ? reason : resolve(label);
}

type BotListStatusKind = "active" | "paused" | "blocked";

interface BotListStatus {
  readonly kind: BotListStatusKind;
  readonly label: string;
}

const BOT_LIST_STATUS_ACTIVE = msg("Active", { $context: "bot status" });
const BOT_LIST_STATUS_PAUSED = msg("Paused");

export function resolveBotListStatus(
  input: {
    readonly botsEnabled: boolean;
    readonly paused: boolean;
    readonly blockedByPolicy: string | undefined;
    readonly blockedReasonCode?: BotBlockReasonCode | undefined;
  },
  resolve: (message: string) => string = m,
): BotListStatus {
  if (!input.botsEnabled) {
    return {
      kind: "blocked",
      label: formatBotBlockReason(BOTS_DISABLED_REASON, resolve, "bots_disabled"),
    };
  }
  if (input.paused) {
    return {
      kind: "paused",
      label: resolve(BOT_LIST_STATUS_PAUSED),
    };
  }
  if (
    input.blockedByPolicy !== undefined &&
    input.blockedByPolicy !== BOT_PAUSED_REASON &&
    input.blockedByPolicy !== BOTS_DISABLED_REASON
  ) {
    return {
      kind: "blocked",
      label: formatBotBlockReason(input.blockedByPolicy, resolve, input.blockedReasonCode),
    };
  }
  return {
    kind: "active",
    label: resolve(BOT_LIST_STATUS_ACTIVE),
  };
}

export function formatBotTodayUsage(
  usage: Pick<BotDailyUsage, "runs" | "tokens"> | null | undefined,
  limits: ResolvedBotLimits,
  resolve: MessageResolver = m,
): string | null {
  if (usage == null) return null;
  const tokens = formatBotTokenCount(usage.tokens);
  if (limits.mode === "runs_and_tokens") {
    return resolve(
      msg("Today: {runs} / {runsLimit} runs · {tokens} / {tokensLimit} tokens", {
        runs: usage.runs,
        runsLimit: limits.runsPerDay,
        tokens,
        tokensLimit: formatBotTokenCount(limits.tokensPerDay),
      }),
    );
  }
  if (limits.mode === "runs_only") {
    return resolve(
      msg("Today: {runs} / {runsLimit} runs · {tokens} tokens", {
        runs: usage.runs,
        runsLimit: limits.runsPerDay,
        tokens,
      }),
    );
  }
  return resolve(
    msg("Today: {runs} runs · {tokens} tokens", {
      runs: usage.runs,
      tokens,
    }),
  );
}

export function botSettingsSelectionKeyFromSearch(search: unknown): string | null {
  if (!Predicate.isObject(search)) return null;
  const bot = typeof search.bot === "string" ? search.bot.trim() : "";
  if (bot.length === 0) return null;
  const env = typeof search.env === "string" ? search.env.trim() : "";
  return `${env}:${bot}`;
}

export function shouldBlockBotNavigation(input: {
  readonly dirty: boolean;
  readonly currentPathname: string;
  readonly nextPathname: string;
  readonly currentSelectionKey?: string | null;
  readonly nextSelectionKey?: string | null;
}): boolean {
  if (!input.dirty) return false;
  if (input.nextPathname !== input.currentPathname) return true;
  return (
    input.currentSelectionKey !== undefined &&
    input.nextSelectionKey !== undefined &&
    input.currentSelectionKey !== input.nextSelectionKey
  );
}
