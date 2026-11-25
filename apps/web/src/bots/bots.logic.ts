import {
  DEFAULT_MODEL_BY_PROVIDER,
  isBotPaused,
  isBotProject,
  isListedThreadLineage,
  providerSupportsBotGate,
  resolveSidebarModeFilter,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ServerSettings,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { SidebarModeFilter } from "@t3tools/contracts/settings";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";

import { getDisplayModelName } from "../components/chat/providerIconUtils";
import type {
  ProjectsSidebarGroupInput,
  ProjectsSidebarThread,
} from "../components/sidebar/ProjectsSidebar.logic";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

type BotServerSettingsLike =
  | (Pick<ServerSettings, "projectSettingsOverrides"> & {
      readonly botsEnabled?: boolean | undefined;
    })
  | null
  | undefined;

export type BotSettingsLookup = (environmentId: EnvironmentId) => BotServerSettingsLike;

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

export function filterNonBotProjects<
  TProject extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  projects: ReadonlyArray<TProject>,
  getServerSettings: BotSettingsLookup,
): ReadonlyArray<TProject> {
  return projects.filter(
    (project) => !isBotProject(getServerSettings(project.environmentId), project.id),
  );
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
  readonly unsupported: boolean;
}

export function resolveBotEffectiveModelSelection(input: {
  readonly botModelSelection: ModelSelection | null | undefined;
  readonly environmentDefaultModelSelection: ModelSelection | null | undefined;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
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
  const unsupported = entry !== undefined && !providerSupportsBotGate(entry.driverKind);

  return { selection, source, driverKind, unsupported };
}

export function resolveFirstSupportedBotModelSelection(
  settings: Pick<ServerSettings, "defaultModelSelection"> | null | undefined,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ModelSelection | null {
  const readySupported = instanceEntries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated" &&
      providerSupportsBotGate(entry.driverKind),
  );
  const fallbackSupported = instanceEntries.filter(
    (entry) => entry.enabled && entry.isAvailable && providerSupportsBotGate(entry.driverKind),
  );
  const pool = readySupported.length > 0 ? readySupported : fallbackSupported;
  if (pool.length === 0) return null;

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

export type BotRunNowDisabledReason = "bots_off" | "paused" | "disconnected" | "no_permission";

export function resolveBotRunNowState(input: {
  readonly botsEnabled: boolean;
  readonly paused: boolean;
  readonly connected: boolean;
  readonly canOperate: boolean;
}): { readonly disabled: boolean; readonly reason: BotRunNowDisabledReason | null } {
  if (!input.botsEnabled) return { disabled: true, reason: "bots_off" };
  if (input.paused) return { disabled: true, reason: "paused" };
  if (!input.connected) return { disabled: true, reason: "disconnected" };
  if (!input.canOperate) return { disabled: true, reason: "no_permission" };
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
