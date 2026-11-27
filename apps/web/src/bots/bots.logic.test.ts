import {
  BOT_DAILY_RUN_LIMIT_REASON,
  BOT_DAILY_TOKEN_LIMIT_REASON,
  BOT_PAUSED_REASON,
  BOT_UNSUPPORTED_PROVIDER_REASON,
  BOTS_DISABLED_REASON,
  botGateUnsupportedFallbackReason,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveSidebarModeFilter,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectsSidebarSections,
  type ProjectsSidebarGroupInput,
  type ProjectsSidebarThread,
} from "../components/sidebar/ProjectsSidebar.logic";
import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  botSettingsSelectionKeyFromSearch,
  deriveBotSidebarEntries,
  filterNonBotProjects,
  filterNonBotThreads,
  formatBotBlockReason,
  formatBotGateUnsupportedReason,
  formatBotModelDisplayName,
  formatBotTodayUsage,
  formatBotTokenCount,
  getBotModelDisabledReason,
  isAnyBotsEnabled,
  isBotEntryGateSupported,
  isBotSidebarRoute,
  keepBotProjectsSeparate,
  parseBotPositiveInt,
  resolveBotEffectiveModelSelection,
  resolveBotListStatus,
  resolveBotRouteSidebarMode,
  resolveBotRunNowState,
  resolveFirstSupportedBotModelSelection,
  shouldBlockBotNavigation,
} from "./bots.logic";

const ENV_LOCAL = EnvironmentId.make("env-local");
const ORDINARY_PROJECT = ProjectId.make("project-ordinary");
const BOT_PROJECT = ProjectId.make("project-bot");
const PAUSED_BOT_PROJECT = ProjectId.make("project-bot-paused");

function makeThread(
  id: string,
  overrides: Partial<ProjectsSidebarThread> = {},
): ProjectsSidebarThread {
  const threadId = ThreadId.make(id);
  return {
    environmentId: ENV_LOCAL,
    id: threadId,
    projectId: ORDINARY_PROJECT,
    title: `Thread ${id}`,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lastVisitedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    pinnedAt: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    ...overrides,
  };
}

function makeGroup(projectId: ProjectId, displayName: string): ProjectsSidebarGroupInput {
  return {
    projectKey: `${ENV_LOCAL}:${projectId}`,
    displayName,
    archived: false,
    memberProjects: [{ environmentId: ENV_LOCAL, id: projectId }],
  };
}

function makeSettings(
  botsEnabled: boolean,
): Pick<ServerSettings, "botsEnabled" | "projectSettingsOverrides"> {
  return {
    botsEnabled,
    projectSettingsOverrides: {
      [BOT_PROJECT]: { bot: {} },
      [PAUSED_BOT_PROJECT]: { bot: { paused: true } },
    },
  };
}

describe("bots client logic", () => {
  it("filters bot projects and threads out of All, Code, and Work while keeping waiting bot threads in Needs you only when bots are on", () => {
    const groups = [
      makeGroup(ORDINARY_PROJECT, "App"),
      makeGroup(BOT_PROJECT, "PR Digest"),
      makeGroup(PAUSED_BOT_PROJECT, "Triage Bot"),
    ];
    const ordinaryWaiting = makeThread("ord-waiting", {
      projectId: ORDINARY_PROJECT,
      hasPendingApprovals: true,
      updatedAt: "2026-10-01T01:00:00.000Z",
    });
    const botWaiting = makeThread("bot-waiting", {
      projectId: BOT_PROJECT,
      hasPendingUserInput: true,
      pinnedAt: "2026-10-01T01:00:00.000Z",
      updatedAt: "2026-10-01T02:00:00.000Z",
    });
    const botIdle = makeThread("bot-idle", {
      projectId: BOT_PROJECT,
      updatedAt: "2026-10-01T03:00:00.000Z",
    });
    const ordinaryPinned = makeThread("ord-pinned", {
      projectId: ORDINARY_PROJECT,
      pinnedAt: "2026-10-01T01:00:00.000Z",
      tags: ["mode:work"],
      updatedAt: "2026-10-01T00:30:00.000Z",
    });
    const threads = [ordinaryWaiting, botWaiting, botIdle, ordinaryPinned];

    for (const modeFilter of ["all", "code", "work"] as const) {
      const sections = buildProjectsSidebarSections({
        projectGroups: groups,
        threads,
        getServerSettings: () => makeSettings(true),
        modeFilter,
      });
      expect(sections.projects.map((entry) => entry.group.displayName)).toEqual(["App"]);
      expect(sections.pinned.map((t) => t.id)).not.toContain(botWaiting.id);
      expect(sections.otherThreads.map((t) => t.id)).not.toContain(botIdle.id);
      expect(sections.needsYou.map((t) => t.id)).toEqual([botWaiting.id, ordinaryWaiting.id]);
    }

    // When bots are off, waiting bot threads are hidden from Needs you too.
    const sectionsOff = buildProjectsSidebarSections({
      projectGroups: groups,
      threads,
      getServerSettings: () => makeSettings(false),
      modeFilter: "all",
    });
    expect(sectionsOff.projects.map((entry) => entry.group.displayName)).toEqual(["App"]);
    expect(sectionsOff.needsYou.map((t) => t.id)).toEqual([ordinaryWaiting.id]);
    expect(sectionsOff.pinned.map((t) => t.id)).toEqual([ordinaryPinned.id]);
    expect(sectionsOff.otherThreads).toEqual([]);
  });

  it("derives bot sidebar entries with paused state and runs only when bots are enabled", () => {
    const groups = [
      makeGroup(ORDINARY_PROJECT, "App"),
      makeGroup(BOT_PROJECT, "PR Digest"),
      makeGroup(PAUSED_BOT_PROJECT, "Alert Bot"),
    ];
    const botRunNew = makeThread("bot-run-new", {
      projectId: BOT_PROJECT,
      updatedAt: "2026-10-01T05:00:00.000Z",
    });
    const botRunOld = makeThread("bot-run-old", {
      projectId: BOT_PROJECT,
      updatedAt: "2026-10-01T01:00:00.000Z",
    });
    const threads = [botRunOld, botRunNew];

    const entries = deriveBotSidebarEntries({
      projectGroups: groups,
      threads,
      getServerSettings: () => makeSettings(true),
    });
    expect(entries.map((entry) => ({ name: entry.name, paused: entry.paused }))).toEqual([
      { name: "Alert Bot", paused: true },
      { name: "PR Digest", paused: false },
    ]);
    expect(entries[1]?.runThreads.map((t) => t.id)).toEqual([botRunNew.id, botRunOld.id]);

    expect(
      deriveBotSidebarEntries({
        projectGroups: groups,
        threads,
        getServerSettings: () => makeSettings(false),
      }),
    ).toEqual([]);
  });

  it("filters bot projects and threads cleanly and resolves bots sidebar mode fallback", () => {
    const getSettings = () => makeSettings(true);
    expect(
      filterNonBotProjects(
        [
          { environmentId: ENV_LOCAL, id: ORDINARY_PROJECT },
          { environmentId: ENV_LOCAL, id: BOT_PROJECT },
        ],
        getSettings,
      ),
    ).toEqual([{ environmentId: ENV_LOCAL, id: ORDINARY_PROJECT }]);

    expect(
      filterNonBotThreads(
        [
          { environmentId: ENV_LOCAL, projectId: ORDINARY_PROJECT, id: "1" },
          { environmentId: ENV_LOCAL, projectId: BOT_PROJECT, id: "2" },
        ],
        getSettings,
      ),
    ).toEqual([{ environmentId: ENV_LOCAL, projectId: ORDINARY_PROJECT, id: "1" }]);

    const ordinary = { environmentId: ENV_LOCAL, id: ORDINARY_PROJECT, workspaceRoot: "/repo" };
    const bot = { environmentId: ENV_LOCAL, id: BOT_PROJECT, workspaceRoot: "/repo/.t3/bots/x" };
    expect(
      keepBotProjectsSeparate(
        [ordinary, bot],
        { [derivePhysicalProjectKey(ordinary)]: "repository" },
        getSettings,
      ),
    ).toEqual({
      [derivePhysicalProjectKey(ordinary)]: "repository",
      [derivePhysicalProjectKey(bot)]: "separate",
    });

    expect(isAnyBotsEnabled([{ serverConfig: { settings: { botsEnabled: true } } }])).toBe(true);
    expect(isAnyBotsEnabled([{ serverConfig: { settings: { botsEnabled: false } } }])).toBe(false);
    expect(isAnyBotsEnabled([{ serverConfig: null }])).toBe(false);

    expect(resolveSidebarModeFilter("bots", false)).toBe("all");
    expect(resolveSidebarModeFilter("bots", true)).toBe("bots");
    expect(resolveSidebarModeFilter("code", false)).toBe("code");
  });

  it("formats token counts and parses positive integer limit inputs", () => {
    expect(formatBotTokenCount(0)).toBe("0");
    expect(formatBotTokenCount(500)).toBe("500");
    expect(formatBotTokenCount(1_250)).toBe("1.3k");
    expect(formatBotTokenCount(45_000)).toBe("45k");
    expect(formatBotTokenCount(2_000_000)).toBe("2M");
    expect(formatBotTokenCount(1_500_000)).toBe("1.5M");

    expect(parseBotPositiveInt("24")).toBe(24);
    expect(parseBotPositiveInt(" 2000000 ")).toBe(2_000_000);
    expect(parseBotPositiveInt("0")).toBeNull();
    expect(parseBotPositiveInt("-5")).toBeNull();
    expect(parseBotPositiveInt("1.5")).toBeNull();
    expect(parseBotPositiveInt("abc")).toBeNull();
  });

  it("resolves effective bot models from botGate capability, filters the model picker by approvals mode, seeds supported models, and formats labels", () => {
    const cursorId = ProviderInstanceId.make("cursor");
    const antigravityId = ProviderInstanceId.make("antigravity");
    const claudeId = ProviderInstanceId.make("claudeAgent");
    const codexId = ProviderInstanceId.make("codex");
    const providers: ReadonlyArray<ServerProvider> = [
      {
        instanceId: cursorId,
        driver: ProviderDriverKind.make("cursor"),
        displayName: "Cursor",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-01T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        botGate: { status: "unsupported", reasonCode: "no_approval_callback" },
        models: [
          {
            slug: "cursor-fast",
            name: "Cursor Fast",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
        ],
      },
      {
        instanceId: antigravityId,
        driver: ProviderDriverKind.make("antigravity"),
        displayName: "Antigravity",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-01T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        botGate: { status: "supported" },
        models: [
          {
            slug: "gemini-pro",
            name: "Gemini Pro",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
        ],
      },
      {
        instanceId: claudeId,
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-01T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        botGate: { status: "supported" },
        models: [
          {
            slug: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
        ],
      },
      {
        instanceId: codexId,
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-01T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        botGate: { status: "supported" },
        models: [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
        ],
      },
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const cursorEntry = entries[0]!;
    const antigravityEntry = entries[1]!;

    // Picker disables unsupported providers under t3_gate and enables them under provider approvals.
    expect(isBotEntryGateSupported(cursorEntry)).toBe(false);
    expect(isBotEntryGateSupported(antigravityEntry)).toBe(true);
    expect(getBotModelDisabledReason(cursorEntry, "t3_gate")).toBe(
      formatBotGateUnsupportedReason("no_approval_callback"),
    );
    expect(getBotModelDisabledReason(cursorEntry, "provider")).toBeNull();
    expect(getBotModelDisabledReason(antigravityEntry, "t3_gate")).toBeNull();

    // Old servers omitting botGate fall back to Claude/Codex only.
    const { botGate: _omittedBotGate, ...legacyAntigravity } = providers[1]!;
    const legacyAntigravityEntries = deriveProviderInstanceEntries([legacyAntigravity]);
    expect(isBotEntryGateSupported(legacyAntigravityEntries[0]!)).toBe(false);

    // Bot inheriting an unsupported app default flags unsupported under t3_gate, allowed under provider.
    const inheritedUnsupported = resolveBotEffectiveModelSelection({
      botModelSelection: null,
      environmentDefaultModelSelection: { instanceId: cursorId, model: "cursor-fast" },
      instanceEntries: entries,
    });
    expect(inheritedUnsupported).toMatchObject({
      source: "default",
      unsupported: true,
      gateCapability: { status: "unsupported", reasonCode: "no_approval_callback" },
      selection: { instanceId: cursorId, model: "cursor-fast" },
    });
    const inheritedProviderMode = resolveBotEffectiveModelSelection({
      botModelSelection: null,
      environmentDefaultModelSelection: { instanceId: cursorId, model: "cursor-fast" },
      instanceEntries: entries,
      approvals: "provider",
    });
    expect(inheritedProviderMode).toMatchObject({
      source: "default",
      unsupported: false,
      selection: { instanceId: cursorId, model: "cursor-fast" },
    });

    // Bot with no explicit model and no app default falls back to first selectable provider.
    const fallbackUnsupported = resolveBotEffectiveModelSelection({
      botModelSelection: null,
      environmentDefaultModelSelection: null,
      instanceEntries: entries,
    });
    expect(fallbackUnsupported).toMatchObject({
      source: "fallback",
      unsupported: true,
      selection: { instanceId: cursorId, model: "cursor-fast" },
    });

    // Bot with an explicit Claude model is supported.
    const explicitClaude = resolveBotEffectiveModelSelection({
      botModelSelection: { instanceId: claudeId, model: "claude-haiku-4-5" },
      environmentDefaultModelSelection: { instanceId: cursorId, model: "cursor-fast" },
      instanceEntries: entries,
    });
    expect(explicitClaude).toMatchObject({
      source: "bot",
      unsupported: false,
      selection: { instanceId: claudeId, model: "claude-haiku-4-5" },
    });

    // Seeding skips an unsupported app default and picks the first available supported model.
    expect(
      resolveFirstSupportedBotModelSelection(
        { defaultModelSelection: { instanceId: cursorId, model: "cursor-fast" } },
        entries,
      ),
    ).toEqual({ instanceId: antigravityId, model: "gemini-pro" });

    // Seeding keeps a supported app default when available.
    expect(
      resolveFirstSupportedBotModelSelection(
        { defaultModelSelection: { instanceId: codexId, model: "gpt-5.4" } },
        entries,
      ),
    ).toEqual({ instanceId: codexId, model: "gpt-5.4" });

    // Seeding prefers a supported botDefaults.modelSelection over defaultModelSelection.
    expect(
      resolveFirstSupportedBotModelSelection(
        {
          defaultModelSelection: { instanceId: codexId, model: "gpt-5.4" },
          botDefaults: {
            modelSelection: { instanceId: claudeId, model: "claude-haiku-4-5" },
          },
        },
        entries,
      ),
    ).toEqual({ instanceId: claudeId, model: "claude-haiku-4-5" });

    // Seeding ignores an unsupported botDefaults.modelSelection and falls back as before.
    expect(
      resolveFirstSupportedBotModelSelection(
        {
          defaultModelSelection: { instanceId: codexId, model: "gpt-5.4" },
          botDefaults: {
            modelSelection: { instanceId: cursorId, model: "cursor-fast" },
          },
        },
        entries,
      ),
    ).toEqual({ instanceId: codexId, model: "gpt-5.4" });

    // Seeding returns null when only unsupported providers exist.
    expect(
      resolveFirstSupportedBotModelSelection(
        { defaultModelSelection: { instanceId: cursorId, model: "cursor-fast" } },
        entries.slice(0, 1),
      ),
    ).toBeNull();

    // Model display formatting uses catalog display name and falls back to raw slug.
    expect(
      formatBotModelDisplayName({ instanceId: claudeId, model: "claude-haiku-4-5" }, entries),
    ).toBe("Claude Haiku 4.5");
    expect(
      formatBotModelDisplayName({ instanceId: claudeId, model: "custom-model" }, entries),
    ).toBe("custom-model");
    expect(formatBotModelDisplayName(null, entries)).toBeNull();
  });

  it("computes Run now availability and derives the Bots sidebar tab on bot routes", () => {
    const ready = {
      botsEnabled: true,
      paused: false,
      connected: true,
      canOperate: true,
      dirty: false,
      blockedByPolicy: undefined,
    };
    // Each case also carries a later blocker, so the order of the reasons is covered.
    const cases = [
      [{ botsEnabled: false, paused: true }, "bots_off"],
      [{ paused: true, connected: false }, "paused"],
      [{ connected: false, canOperate: false }, "disconnected"],
      [{ canOperate: false, dirty: true }, "no_permission"],
      [{ dirty: true, blockedByPolicy: "Daily run limit reached" }, "unsaved"],
      [{ blockedByPolicy: "Daily run limit reached" }, "blocked"],
    ] as const;
    for (const [overrides, reason] of cases) {
      expect(resolveBotRunNowState({ ...ready, ...overrides })).toEqual({ disabled: true, reason });
    }
    expect(resolveBotRunNowState(ready)).toEqual({ disabled: false, reason: null });

    const groups = [makeGroup(ORDINARY_PROJECT, "App"), makeGroup(BOT_PROJECT, "PR Digest")];
    const getSettings = () => makeSettings(true);

    expect(
      isBotSidebarRoute({
        activeProjectKey: `${ENV_LOCAL}:${BOT_PROJECT}`,
        activeThreadProject: null,
        projectGroups: groups,
        getServerSettings: getSettings,
      }),
    ).toBe(true);
    expect(
      isBotSidebarRoute({
        activeProjectKey: null,
        activeThreadProject: { environmentId: ENV_LOCAL, projectId: BOT_PROJECT },
        projectGroups: groups,
        getServerSettings: getSettings,
      }),
    ).toBe(true);
    expect(
      isBotSidebarRoute({
        activeProjectKey: `${ENV_LOCAL}:${ORDINARY_PROJECT}`,
        activeThreadProject: { environmentId: ENV_LOCAL, projectId: ORDINARY_PROJECT },
        projectGroups: groups,
        getServerSettings: getSettings,
      }),
    ).toBe(false);

    // Bot route selects Bots tab even when saved filter is All; explicit override can switch away.
    expect(
      resolveBotRouteSidebarMode({
        savedMode: "all",
        botsEnabled: true,
        isBotRoute: true,
        routeOverride: null,
      }),
    ).toBe("bots");
    expect(
      resolveBotRouteSidebarMode({
        savedMode: "all",
        botsEnabled: true,
        isBotRoute: true,
        routeOverride: "all",
      }),
    ).toBe("all");
    expect(
      resolveBotRouteSidebarMode({
        savedMode: "work",
        botsEnabled: true,
        isBotRoute: false,
        routeOverride: null,
      }),
    ).toBe("work");
    expect(
      resolveBotRouteSidebarMode({
        savedMode: "all",
        botsEnabled: false,
        isBotRoute: true,
        routeOverride: null,
      }),
    ).toBe("all");
  });

  it("maps known bot block reasons through the message resolver and passes unknown strings through", () => {
    const resolved: string[] = [];
    const resolve = (message: string) => {
      resolved.push(message);
      return `[de] ${message}`;
    };

    for (const reason of [
      BOTS_DISABLED_REASON,
      BOT_PAUSED_REASON,
      BOT_DAILY_RUN_LIMIT_REASON,
      BOT_DAILY_TOKEN_LIMIT_REASON,
      BOT_UNSUPPORTED_PROVIDER_REASON,
      botGateUnsupportedFallbackReason("no_approval_callback"),
    ]) {
      expect(formatBotBlockReason(reason, resolve)).toBe(`[de] ${reason}`);
    }
    expect(formatBotBlockReason("Fallback text", resolve, "ungated_mcp_or_tools")).toBe(
      `[de] ${botGateUnsupportedFallbackReason("ungated_mcp_or_tools")}`,
    );
    expect(resolved).toHaveLength(7);

    expect(formatBotBlockReason("Future server limit", resolve)).toBe("Future server limit");
    expect(formatBotBlockReason("toString", resolve)).toBe("toString");
    expect(resolved).toHaveLength(7);
  });

  it("blocks bot navigation only when dirty and moving to another pathname", () => {
    expect(
      shouldBlockBotNavigation({
        dirty: true,
        currentPathname: "/projects/env:bot-a",
        nextPathname: "/projects/env:bot-b",
      }),
    ).toBe(true);
    expect(
      shouldBlockBotNavigation({
        dirty: true,
        currentPathname: "/projects/env:bot-a",
        nextPathname: "/settings/general",
      }),
    ).toBe(true);
    expect(
      shouldBlockBotNavigation({
        dirty: true,
        currentPathname: "/projects/env:bot-a",
        nextPathname: "/projects/env:bot-a",
      }),
    ).toBe(false);
    expect(
      shouldBlockBotNavigation({
        dirty: false,
        currentPathname: "/projects/env:bot-a",
        nextPathname: "/settings/general",
      }),
    ).toBe(false);
    expect(
      shouldBlockBotNavigation({
        dirty: true,
        currentPathname: "/settings/bots",
        nextPathname: "/settings/bots",
        currentSelectionKey: botSettingsSelectionKeyFromSearch({ bot: "bot-a", env: "env-1" }),
        nextSelectionKey: botSettingsSelectionKeyFromSearch({}),
      }),
    ).toBe(true);
    expect(
      shouldBlockBotNavigation({
        dirty: true,
        currentPathname: "/settings/bots",
        nextPathname: "/settings/bots",
        currentSelectionKey: botSettingsSelectionKeyFromSearch({ bot: "bot-a", env: "env-1" }),
        nextSelectionKey: botSettingsSelectionKeyFromSearch({ bot: "bot-a", env: "env-1" }),
      }),
    ).toBe(false);
  });

  it("derives bot settings list status and formats today's usage text", () => {
    expect(
      resolveBotListStatus({ botsEnabled: true, paused: false, blockedByPolicy: undefined }),
    ).toEqual({ kind: "active", label: "Active" });
    expect(
      resolveBotListStatus({
        botsEnabled: true,
        paused: true,
        blockedByPolicy: BOT_PAUSED_REASON,
      }),
    ).toEqual({ kind: "paused", label: "Paused" });
    expect(
      resolveBotListStatus({
        botsEnabled: false,
        paused: false,
        blockedByPolicy: BOTS_DISABLED_REASON,
      }),
    ).toEqual({ kind: "blocked", label: BOTS_DISABLED_REASON });
    expect(
      resolveBotListStatus({
        botsEnabled: true,
        paused: false,
        blockedByPolicy: BOT_DAILY_RUN_LIMIT_REASON,
      }),
    ).toEqual({ kind: "blocked", label: BOT_DAILY_RUN_LIMIT_REASON });
    expect(
      resolveBotListStatus(
        {
          botsEnabled: true,
          paused: false,
          blockedByPolicy: BOT_DAILY_TOKEN_LIMIT_REASON,
        },
        (message) => `[fr] ${message}`,
      ),
    ).toEqual({ kind: "blocked", label: `[fr] ${BOT_DAILY_TOKEN_LIMIT_REASON}` });
    expect(
      resolveBotListStatus({
        botsEnabled: true,
        paused: false,
        blockedByPolicy: BOT_PAUSED_REASON,
      }),
    ).toEqual({ kind: "active", label: "Active" });

    expect(
      formatBotTodayUsage(null, {
        mode: "runs_and_tokens",
        runsPerDay: 24,
        tokensPerDay: 2_000_000,
      }),
    ).toBeNull();
    expect(
      formatBotTodayUsage(
        { runs: 3, tokens: 125_000 },
        { mode: "runs_and_tokens", runsPerDay: 24, tokensPerDay: 2_000_000 },
      ),
    ).toBe("Today: 3 / 24 runs · 125k / 2M tokens");
    expect(
      formatBotTodayUsage(
        { runs: 3, tokens: 125_000 },
        { mode: "runs_only", runsPerDay: 10, tokensPerDay: 2_000_000 },
      ),
    ).toBe("Today: 3 / 10 runs · 125k tokens");
    expect(
      formatBotTodayUsage(
        { runs: 3, tokens: 125_000 },
        { mode: "none", runsPerDay: 24, tokensPerDay: 2_000_000 },
      ),
    ).toBe("Today: 3 runs · 125k tokens");
  });
});
