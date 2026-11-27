import { describe, expect, it } from "@effect/vitest";
import {
  type BotGateCapability,
  type BotGateUnsupportedReasonCode,
  botGateUnsupportedFallbackReason,
  ClaudeSettings,
  EnvironmentId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  acpMcpToolApprovalElicitationDisposition,
  acpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import {
  extractMcpToolCallIdentity,
  parsePermissionRequest,
  withTrackedPermissionToolCall,
} from "@t3tools/provider-acp/server/runtimeModel";
import { normalizeXAiAcpToolCallState } from "@t3tools/provider-grok/testing";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  claudeMcpQueryOverrides,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { antigravityPermissionDisposition } from "../provider/acp/AntigravityAcpSupport.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const NOW = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z");
const BOT_PROJECT = ProjectId.make("project:bot-runtime");
const ORDINARY_PROJECT = ProjectId.make("project:ordinary-runtime");

const BUILT_IN_BOT_GATE_BY_DRIVER: ReadonlyMap<ProviderDriverKind, BotGateCapability> = new Map(
  BUILT_IN_DRIVERS.map((driver) => [
    driver.driverKind,
    driver.metadata.botGate ?? { status: "unsupported", reasonCode: "unverified_third_party_acp" },
  ]),
);

const makeTestProviderInstance = Effect.fn("BotRuntimeGateTest.makeTestProviderInstance")(
  function* (instanceId: ProviderInstanceId, driverKind: ProviderDriverKind) {
    const adapter = yield* ProviderAdapter.ProviderAdapterV2.pipe(
      Effect.provide(
        Layer.mock(ProviderAdapter.ProviderAdapterV2)({
          instanceId,
          driver: driverKind,
        }),
      ),
    );
    const botGate = BUILT_IN_BOT_GATE_BY_DRIVER.get(driverKind);
    const snapshotValue: ServerProvider = {
      instanceId,
      driver: driverKind,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-01T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
      ...(botGate === undefined ? {} : { botGate }),
    };
    const instance: ProviderInstance = {
      instanceId,
      driverKind,
      continuationIdentity: { driverKind, continuationKey: instanceId },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed({
            provider: driverKind,
            packageName: null,
            update: null,
          }),
        getSnapshot: Effect.succeed(snapshotValue),
        refresh: Effect.succeed(snapshotValue),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      orchestrationAdapter: adapter,
      textGeneration: {
        generateTranscriptionPostProcessing: () => Effect.die("unused"),
        generateCommitMessage: () => Effect.die("unused"),
        generatePrContent: () => Effect.die("unused"),
        generateBranchName: () => Effect.die("unused"),
        generateThreadTitle: () => Effect.die("unused"),
        generateReviewGuide: () => Effect.die("unused"),
      },
    };
    return instance;
  },
);

function makeThread(
  projectId: ProjectId,
  runtimeMode: OrchestrationV2AppThread["runtimeMode"],
): OrchestrationV2AppThread {
  const id = ThreadId.make(`thread:${projectId}`);
  return {
    id,
    projectId,
    title: "Test thread",
    branch: null,
    worktreePath: "/tmp/workspace",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "server",
    pinnedAt: null,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const makeHarness = Effect.fn("BotRuntimeGateTest.makeHarness")(function* (
  driversByInstance: Readonly<Record<string, ProviderDriverKind>>,
  options?: { readonly botApprovals?: "t3_gate" | "provider" },
) {
  const settingsLayer = ServerSettings.layerTest({
    botsEnabled: true,
    projectSettingsOverrides: {
      [BOT_PROJECT]: {
        bot: options?.botApprovals === undefined ? {} : { approvals: options.botApprovals },
      },
    },
  });

  const deps = Layer.mergeAll(
    settingsLayer,
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeedSome({
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/workspace",
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          hasCustomTitle: false,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          trackedFolders: [],
          pinnedAt: null,
          archivedAt: null,
          createdAt: "2026-10-01T12:00:00.000Z",
          updatedAt: "2026-10-01T12:00:00.000Z",
          deletedAt: null,
        }),
    }),
    Layer.mock(WorkspaceFolders.WorkspaceFolders)({
      forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (instanceId) => {
        const driverKind = driversByInstance[instanceId];
        if (driverKind === undefined) return Effect.undefined;
        return makeTestProviderInstance(instanceId, driverKind);
      },
    }),
  );

  const ctx = yield* Layer.build(
    RuntimePolicy.layerFromProjectStore.pipe(Layer.provideMerge(deps)),
  );
  const policy = yield* RuntimePolicy.RuntimePolicyV2.pipe(Effect.provide(ctx));
  const settings = yield* ServerSettings.ServerSettingsService.pipe(Effect.provide(ctx));
  return { policy, settings };
});

describe("bot runtime mode clamp and provider gate", () => {
  it.effect(
    "clamps bot threads to approval-required at turn start without mutating thread fields, restores when bot marker is removed, and leaves ordinary threads untouched",
    () =>
      Effect.gen(function* () {
        const { policy, settings } = yield* makeHarness({
          claude: ProviderDriverKind.make("claudeAgent"),
          codex: ProviderDriverKind.make("codex"),
          antigravity: ProviderDriverKind.make("antigravity"),
          grok: ProviderDriverKind.make("grok"),
        });

        const botThread = makeThread(BOT_PROJECT, "full-access");
        const ordinaryThread = makeThread(ORDINARY_PROJECT, "full-access");
        const claudeSelection = {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-sonnet-4-5",
        };
        const codexSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        };

        for (const selection of [
          claudeSelection,
          codexSelection,
          { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini-2.5-pro" },
          { instanceId: ProviderInstanceId.make("grok"), model: "grok-4" },
        ]) {
          const resolved = yield* policy.resolve({
            thread: botThread,
            modelSelection: selection,
          });
          expect(resolved.runtimeMode).toBe("approval-required");
          expect(resolved.maxRuntimeMode).toBe("approval-required");
          expect(resolved.gateAllMcpTools).toBe(true);
        }
        // Stored thread field stays untouched.
        expect(botThread.runtimeMode).toBe("full-access");

        const ordinaryPolicy = yield* policy.resolve({
          thread: ordinaryThread,
          modelSelection: codexSelection,
        });
        expect(ordinaryPolicy.runtimeMode).toBe("full-access");
        expect(ordinaryPolicy.maxRuntimeMode).toBeUndefined();
        expect(ordinaryPolicy.gateAllMcpTools).toBeUndefined();

        // Removing the bot marker restores the stored full-access mode.
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [BOT_PROJECT]: null,
          },
        });
        const restoredPolicy = yield* policy.resolve({
          thread: botThread,
          modelSelection: codexSelection,
        });
        expect(restoredPolicy.runtimeMode).toBe("full-access");
        expect(restoredPolicy.gateAllMcpTools).toBeUndefined();
      }).pipe(Effect.scoped),
  );

  it.effect("refuses bot turns on unsupported providers with their structured reason codes", () =>
    Effect.gen(function* () {
      const unsupportedDrivers: ReadonlyArray<
        readonly [ProviderDriverKind, BotGateUnsupportedReasonCode]
      > = [
        [ProviderDriverKind.make("cursor"), "no_approval_callback"],
        [ProviderDriverKind.make("opencode"), "ungated_mcp_or_tools"],
        [ProviderDriverKind.make("pi"), "ungated_mcp_or_tools"],
        [ProviderDriverKind.make("kiro"), "unisolated_user_rules"],
        [ProviderDriverKind.make("muse"), "unisolated_user_rules"],
        [ProviderDriverKind.make("fx"), "opaque_subagents_or_mcp"],
        [ProviderDriverKind.make("acpRegistry"), "unverified_third_party_acp"],
      ];
      const driversByInstance = Object.fromEntries(
        unsupportedDrivers.map(([driver]) => [`inst-${driver}`, driver]),
      );
      const { policy } = yield* makeHarness(driversByInstance);
      const botThread = makeThread(BOT_PROJECT, "full-access");
      const ordinaryThread = makeThread(ORDINARY_PROJECT, "full-access");

      for (const [driver, expectedReasonCode] of unsupportedDrivers) {
        const selection = {
          instanceId: ProviderInstanceId.make(`inst-${driver}`),
          model: "test-model",
        };
        const failure = yield* policy
          .resolve({ thread: botThread, modelSelection: selection })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("RuntimePolicyBotProviderUnsupportedError");
        if (failure._tag === "RuntimePolicyBotProviderUnsupportedError") {
          expect(failure.reasonCode).toBe(expectedReasonCode);
        }
        expect(failure.message).toBe(botGateUnsupportedFallbackReason(expectedReasonCode));

        // Ordinary projects still run on those providers without error.
        const ordinaryResolved = yield* policy.resolve({
          thread: ordinaryThread,
          modelSelection: selection,
        });
        expect(ordinaryResolved.runtimeMode).toBe("full-access");
      }

      const missing = yield* policy
        .resolve({
          thread: botThread,
          modelSelection: { instanceId: ProviderInstanceId.make("removed"), model: "test-model" },
        })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("RuntimePolicyBotProviderUnsupportedError");
      if (missing._tag === "RuntimePolicyBotProviderUnsupportedError") {
        expect(missing.reasonCode).toBe("provider_unavailable");
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "allows unsupported providers like Cursor when bot approvals is provider, while keeping approval-required clamp and rejecting missing instances",
    () =>
      Effect.gen(function* () {
        const cursorSelection = {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "cursor-fast",
        };
        const botThread = makeThread(BOT_PROJECT, "full-access");

        const t3GateHarness = yield* makeHarness(
          { cursor: ProviderDriverKind.make("cursor") },
          { botApprovals: "t3_gate" },
        );
        const refused = yield* t3GateHarness.policy
          .resolve({ thread: botThread, modelSelection: cursorSelection })
          .pipe(Effect.flip);
        expect(refused._tag).toBe("RuntimePolicyBotProviderUnsupportedError");
        if (refused._tag === "RuntimePolicyBotProviderUnsupportedError") {
          expect(refused.reasonCode).toBe("no_approval_callback");
        }

        const providerHarness = yield* makeHarness(
          { cursor: ProviderDriverKind.make("cursor") },
          { botApprovals: "provider" },
        );
        const allowed = yield* providerHarness.policy.resolve({
          thread: botThread,
          modelSelection: cursorSelection,
        });
        expect(allowed.runtimeMode).toBe("approval-required");
        expect(allowed.maxRuntimeMode).toBe("approval-required");
        expect(allowed.gateAllMcpTools).toBe(true);

        const missing = yield* providerHarness.policy
          .resolve({
            thread: botThread,
            modelSelection: { instanceId: ProviderInstanceId.make("removed"), model: "test" },
          })
          .pipe(Effect.flip);
        expect(missing._tag).toBe("RuntimePolicyBotProviderUnsupportedError");
        if (missing._tag === "RuntimePolicyBotProviderUnsupportedError") {
          expect(missing.reasonCode).toBe("provider_unavailable");
        }
      }).pipe(Effect.scoped),
  );

  it("omits mcp__t3-code__* pre-approval for Claude when gateAllMcpTools is true", () => {
    const overrides = claudeMcpQueryOverrides({
      mcpSession: {
        environmentId: EnvironmentId.make("env:local"),
        threadId: ThreadId.make("thread:bot-mcp"),
        providerSessionId: ProviderSessionId.make("psess:bot-mcp"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        endpoint: "http://127.0.0.1:4321/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
        hasPendingWake: Effect.succeed(false),
      },
      readOnlySandbox: false,
      gateAllMcpTools: true,
    });
    expect(overrides.allowedTools).toEqual([]);
    expect(overrides.mcpServers?.["t3-code"]).toBeDefined();
  });

  it("ignores permission launch args and drops user settingSources on Claude bot runs while keeping non-bot threads unchanged", () => {
    const settings = decodeClaudeSettings({
      launchArgs:
        "--dangerously-skip-permissions --permission-mode bypassPermissions --setting-sources user,project",
    });
    const baseInput = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native-thread-1",
      resume: false,
      cwd: "/tmp/workspace",
      settings,
      permissionMode: "default" as const,
      allowDangerouslySkipPermissions: true,
    };

    const botOptions = makeClaudeQueryOptions({ ...baseInput, gateAllMcpTools: true });
    expect(botOptions.permissionMode).toBe("default");
    expect(botOptions.allowDangerouslySkipPermissions).toBeUndefined();
    expect(botOptions.settingSources).toEqual(["project", "local"]);
    expect(botOptions.extraArgs?.["setting-sources"]).toBeUndefined();
    expect(botOptions.extraArgs?.["dangerously-skip-permissions"]).toBeUndefined();
    expect(botOptions.extraArgs?.["permission-mode"]).toBeUndefined();

    const ordinaryOptions = makeClaudeQueryOptions(baseInput);
    expect(ordinaryOptions.permissionMode).toBe("bypassPermissions");
    expect(ordinaryOptions.allowDangerouslySkipPermissions).toBe(true);
    expect(ordinaryOptions.settingSources).toBeUndefined();
    expect(ordinaryOptions.extraArgs?.["setting-sources"]).toBe("user,project");
  });

  it("does not auto-allow ACP read/search/think, MCP elicitations, or Antigravity T3 MCP calls on bot runs", () => {
    const basePolicy: AcpRuntimePolicy = {
      runtimeMode: "approval-required",
      cwd: "/tmp/workspace",
    };
    const botPolicy: AcpRuntimePolicy = {
      ...basePolicy,
      gateAllMcpTools: true,
    };

    for (const kind of ["read", "search", "think"] as const) {
      const request = {
        options: [],
        sessionId: "s-1",
        toolCall: { kind, toolCallId: `tc-${kind}` },
      };
      expect(acpPermissionDisposition(basePolicy, request)).toBe("allow");
      expect(acpPermissionDisposition(botPolicy, request)).toBe("ask");
    }

    const mcpElicitation = {
      sessionId: "s-1",
      message: "Approve MCP tool?",
      mode: "form" as const,
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call" },
    };
    expect(
      acpMcpToolApprovalElicitationDisposition(
        { runtimeMode: "full-access", cwd: "/tmp/workspace", gateAllMcpTools: true },
        mcpElicitation,
      ),
    ).toBe("ask");

    const t3McpRequest = {
      options: [],
      sessionId: "s-1",
      toolCall: {
        kind: "other" as const,
        toolCallId: "tc-t3-mcp",
        title: "MCP Tool t3_thread_send",
        rawInput: { ServerName: "t3-code", ToolName: "t3_thread_send" },
      },
    };
    const autoEditsPolicy: AcpRuntimePolicy = {
      runtimeMode: "auto-accept-edits",
      cwd: "/tmp/workspace",
    };
    expect(antigravityPermissionDisposition(autoEditsPolicy, t3McpRequest)).toBe("allow");
    expect(
      antigravityPermissionDisposition({ ...autoEditsPolicy, gateAllMcpTools: true }, t3McpRequest),
    ).toBe("ask");
    expect(antigravityPermissionDisposition(botPolicy, t3McpRequest)).toBe("ask");
  });

  it("normalizes Grok use_tool permission requests to <server>.<tool> before the bot gate", () => {
    const merged = withTrackedPermissionToolCall(
      {
        sessionId: "s-grok",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        toolCall: {
          toolCallId: "tc-grok-mcp",
          title: "use_tool",
          kind: "other",
        },
      },
      {
        toolCallId: "tc-grok-mcp",
        kind: "other",
        data: {
          toolCallId: "tc-grok-mcp",
          title: "use_tool",
          rawInput: { tool_name: "gmail__send_email", args: { to: "a@b.com" } },
          meta: { "x.ai/tool": { name: "use_tool" } },
        },
      },
    );

    const parsed = parsePermissionRequest(merged, normalizeXAiAcpToolCallState);
    expect(parsed.detail).toBe("gmail.send_email");
    expect(
      parsed.toolCall === undefined ? undefined : extractMcpToolCallIdentity(parsed.toolCall),
    ).toEqual({
      server: "gmail",
      tool: "send_email",
    });
  });
});
