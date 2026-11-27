import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type BotGateCapability,
  type BotGateUnsupportedReasonCode,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  type RuntimeRequestId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import {
  ANTIGRAVITY_REPLAY_INSTANCE_ID,
  AntigravityOrchestratorReplayHarness,
} from "../orchestration-v2/Adapters/AntigravityAdapterV2.testkit.ts";
import { ClaudeOrchestratorReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { GrokOrchestratorReplayHarness } from "../orchestration-v2/Adapters/GrokAdapterV2.testkit.ts";
import * as CheckpointCaptureService from "../orchestration-v2/CheckpointCaptureService.ts";
import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderSwitchService from "../orchestration-v2/ProviderSwitchService.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProviderTurnStartServiceTestkit from "../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as RunFinalizationService from "../orchestration-v2/RunFinalizationService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as RuntimeRequestService from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as CommandOutputRecorder from "../orchestration-v2/testkit/CommandOutputRecorder.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TaskFolderStore from "../workspace/TaskFolderStore.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import { ThreadWorktreeRestore } from "../workspace/restoreMissingWorktree.ts";
import * as BotActionGateReactor from "./BotActionGateReactor.ts";
import { BOT_HELD_APPROVAL_OPTIONS, BOT_PAY_BLOCKED_FEEDBACK } from "./botActionPolicy.ts";

const BOT_PROJECT_ID = ProjectId.make("project:bot-conformance");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const GROK_INSTANCE_ID = ProviderInstanceId.make("grok");
const CLAUDE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_THREAD_ID = "01a0d604-1f8d-7522-8fe1-371c6626896e";
const CODEX_TURN_ID = "01a0d604-2095-7fb0-a7e6-3f63d1949bbe";
const ACP_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PROBE_PROMPT = "Run bot conformance probe.";

const BUILT_IN_BOT_GATE_BY_DRIVER: ReadonlyMap<ProviderDriverKind, BotGateCapability> = new Map(
  BUILT_IN_DRIVERS.map((driver) => [
    driver.driverKind,
    driver.metadata.botGate ?? { status: "unsupported", reasonCode: "unverified_third_party_acp" },
  ]),
);

const makeSnapshotInstance = Effect.fn("BotConformance.makeSnapshotInstance")(function* (
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
) {
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
});

type ProbeExpectation =
  | { readonly kind: "hold"; readonly expectedReason: string }
  | { readonly kind: "block_pay" }
  | { readonly kind: "auto_allow" }
  | { readonly kind: "turn_complete" };

function makeRegistryLayerFactory<Transcript extends ProviderReplayTranscript, Err>(
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Err>,
) {
  return (
    transcript: ProviderReplayTranscript,
  ): Effect.Effect<
    Layer.Layer<
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      never,
      McpProviderSessions.McpProviderSessions
    >
  > =>
    harness.decodeTranscript(transcript).pipe(
      Effect.orDie,
      Effect.map((decoded) => harness.makeProviderAdapterRegistryLayer(decoded).pipe(Layer.orDie)),
    );
}

interface DriverConformanceSpec {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly makeAdapterRegistryLayer: (
    transcript: ProviderReplayTranscript,
  ) => Effect.Effect<
    Layer.Layer<
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      never,
      McpProviderSessions.McpProviderSessions
    >
  >;
  readonly probes: {
    readonly shellSend: () => ProviderReplayTranscript;
    readonly fileDelete: () => ProviderReplayTranscript;
    readonly mcpSendT3: () => ProviderReplayTranscript;
    readonly mcpSendThirdParty: () => ProviderReplayTranscript;
    readonly webFetch: {
      readonly build: () => ProviderReplayTranscript;
      readonly expectation: ProbeExpectation;
    };
    readonly payBlock: () => ProviderReplayTranscript;
  };
}

function makeClaudeProbeTranscript(input: {
  readonly scenario: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly expectedBehavior: "allow" | "deny";
  readonly expectedDenyMessage?: string;
}): ProviderReplayTranscript {
  const responseResult =
    input.expectedBehavior === "allow"
      ? {
          behavior: "allow",
          updatedInput: input.toolInput,
          toolUseID: input.toolUseId,
          decisionClassification: "user_temporary",
        }
      : {
          behavior: "deny",
          message: input.expectedDenyMessage ?? "User declined tool execution.",
          toolUseID: input.toolUseId,
          decisionClassification: "user_reject",
        };
  return {
    provider: ProviderDriverKind.make("claudeAgent"),
    protocol: "claude-agent-sdk.query",
    version: "0.2.111",
    scenario: input.scenario,
    metadata: {
      prompts: [PROBE_PROMPT],
      model: "claude-sonnet-4-6",
      nativeSessionId: CLAUDE_SESSION_ID,
      queryMode: "streaming",
      tools: "claude_code",
      permissionMode: "default",
      enablePermissionCallback: true,
    },
    entries: [
      {
        type: "expect_outbound",
        label: "query.open",
        frame: {
          type: "query.open",
          options: {
            model: "claude-sonnet-4-6",
            tools: { type: "preset", preset: "claude_code" },
            permissionMode: "default",
            sessionId: CLAUDE_SESSION_ID,
            settings: { showThinkingSummaries: true },
          },
        },
      },
      {
        type: "expect_outbound",
        label: "prompt.offer:1",
        frame: {
          type: "prompt.offer",
          message: {
            type: "user",
            message: { role: "user", content: PROBE_PROMPT },
            parent_tool_use_id: null,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "system",
        frame: {
          type: "system",
          subtype: "init",
          agents: [],
          apiKeySource: "none",
          claude_code_version: "2.1.111",
          cwd: "/tmp/claude-conformance",
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          fast_mode_state: "off",
          uuid: "c5dfaae5-ef85-4e12-8409-cc9351fd7210",
          session_id: CLAUDE_SESSION_ID,
        },
      },
      {
        type: "emit_inbound",
        label: "assistant",
        frame: {
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            id: "msg_01_conformance_tool",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: input.toolUseId,
                name: input.toolName,
                input: input.toolInput,
                caller: { type: "direct" },
              },
            ],
            stop_reason: null,
            stop_sequence: null,
            stop_details: null,
            usage: { input_tokens: 10, output_tokens: 10 },
            context_management: null,
          },
          parent_tool_use_id: null,
          session_id: CLAUDE_SESSION_ID,
          uuid: "4887439e-b0cd-4d24-88d7-b60dfc5268b0",
        },
      },
      {
        type: "emit_inbound",
        label: `permission.request:${input.toolName}`,
        frame: {
          type: "permission.request",
          toolName: input.toolName,
          input: input.toolInput,
          options: {
            displayName: input.toolName,
            toolUseID: input.toolUseId,
          },
        },
      },
      {
        type: "expect_outbound",
        label: `permission.response:${input.toolName}`,
        frame: {
          type: "permission.response",
          result: responseResult,
        },
      },
      {
        type: "emit_inbound",
        label: "user",
        frame: {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: input.toolUseId,
                type: "tool_result",
                content: "done",
                is_error: input.expectedBehavior === "deny",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: CLAUDE_SESSION_ID,
          uuid: "fc89ff85-b44d-4429-b85a-ccaf034bbcfc",
        },
      },
      {
        type: "emit_inbound",
        label: "result",
        frame: {
          type: "result",
          subtype: "success",
          is_error: false,
          api_error_status: null,
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          result: "probe done",
          stop_reason: "end_turn",
          session_id: CLAUDE_SESSION_ID,
          total_cost_usd: 0.001,
          usage: { input_tokens: 10, output_tokens: 10 },
          modelUsage: {},
          permission_denials: [],
          terminal_reason: "completed",
          fast_mode_state: "off",
          uuid: "1b85e0c8-2cd3-44dc-b33a-4e084453cc9d",
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  };
}

function makeCodexBasePrefix(input: {
  readonly scenario: string;
  readonly threadId: ThreadId;
  readonly extraTurnEntries: ReadonlyArray<ProviderReplayTranscript["entries"][number]>;
}): ProviderReplayTranscript {
  return {
    provider: ProviderDriverKind.make("codex"),
    protocol: "codex.app-server",
    version: "0.156.1",
    scenario: input.scenario,
    metadata: { model: "gpt-5" },
    entries: [
      {
        type: "expect_outbound",
        label: "initialize",
        frame: {
          id: 1,
          method: "initialize",
          params: {
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: ["turn/diff/updated"],
              extensions: {
                "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
              },
            },
            clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" },
          },
        },
      },
      {
        type: "emit_inbound",
        label: "initialize",
        frame: {
          id: 1,
          result: {
            userAgent: "t3code_desktop/0.156.1",
            codexHome: "/home/replay-user/.codex",
            platformFamily: "unix",
            platformOs: "linux",
          },
        },
      },
      { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
      {
        type: "expect_outbound",
        label: "config/read",
        frame: {
          id: 2,
          method: "config/read",
          params: { cwd: "<workspace>", includeLayers: false },
        },
      },
      {
        type: "emit_inbound",
        label: "config/read",
        frame: { id: 2, result: { config: {}, origins: {} } },
      },
      {
        type: "expect_outbound",
        label: "thread/start",
        frame: {
          id: 3,
          method: "thread/start",
          params: {
            config: {
              "tools.update_plan.enabled": true,
              mcp_optional_startup_grace_ms: 10000,
              "features.concurrent_reasoning_summaries": true,
              web_search: "disabled",
              "shell_environment_policy.set.T3CODE_THREAD_ID": input.threadId,
            },
            cwd: "<workspace>",
            model: "gpt-5",
          },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/start",
        frame: {
          id: 3,
          result: {
            thread: {
              id: CODEX_THREAD_ID,
              cwd: "<workspace>",
              modelProvider: "openai",
              model: "gpt-5",
              preview: "",
              ephemeral: false,
              cliVersion: "0.156.1",
              source: "vscode",
              createdAt: 1790296989,
              updatedAt: 1790296989,
              status: { type: "idle" },
              turns: [],
            },
            model: "gpt-5",
            modelProvider: "openai",
            cwd: "<workspace>",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/name/set",
        frame: {
          id: 4,
          method: "thread/name/set",
          params: { name: "Bot conformance", threadId: CODEX_THREAD_ID },
        },
      },
      { type: "emit_inbound", label: "thread/name/set", frame: { id: 4, result: {} } },
      {
        type: "expect_outbound",
        label: "config/read",
        frame: {
          id: 5,
          method: "config/read",
          params: { cwd: "<workspace>", includeLayers: false },
        },
      },
      {
        type: "emit_inbound",
        label: "config/read",
        frame: { id: 5, result: { config: {}, origins: {} } },
      },
      {
        type: "expect_outbound",
        label: "turn/start",
        frame: {
          id: 6,
          method: "turn/start",
          params: {
            approvalPolicy: "untrusted",
            approvalsReviewer: "user",
            cwd: "<workspace>",
            input: [{ text: PROBE_PROMPT, type: "text" }],
            model: "gpt-5",
            sandboxPolicy: {
              type: "readOnly",
            },
            summary: "auto",
            threadId: CODEX_THREAD_ID,
            collaborationMode: { mode: "default", settings: { model: "gpt-5" } },
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/start",
        frame: {
          id: 6,
          result: { turn: { id: CODEX_TURN_ID, items: [], status: "inProgress", error: null } },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started",
        frame: {
          method: "turn/started",
          params: {
            threadId: CODEX_THREAD_ID,
            turn: { id: CODEX_TURN_ID, items: [], status: "inProgress", error: null },
          },
        },
      },
      ...input.extraTurnEntries,
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: CODEX_THREAD_ID,
            turn: { id: CODEX_TURN_ID, items: [], status: "completed", error: null },
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  };
}

function makeAcpProbeTranscript(input: {
  readonly driver: "antigravity" | "grok";
  readonly scenario: string;
  readonly toolCallStart?: Readonly<Record<string, unknown>>;
  readonly permissionToolCall: Readonly<Record<string, unknown>>;
  readonly expectedOptionId: "allow-once" | "reject-once";
}): ProviderReplayTranscript {
  const isGrok = input.driver === "grok";
  const initializeResult = isGrok
    ? {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          auth: {},
        },
        authMethods: [{ id: "cached_token", name: "cached_token" }],
        _meta: {
          agentVersion: "1.0.41",
          modelState: {
            currentModelId: "grok-4.7",
            availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7" }],
          },
        },
      }
    : {
        protocolVersion: 1,
        agentInfo: { name: "antigravity", version: "2.0.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          auth: {},
        },
        authMethods: [{ id: "replay", name: "Replay" }],
      };

  const sessionNewResult = isGrok
    ? {
        sessionId: ACP_SESSION_ID,
        models: {
          currentModelId: "grok-4.7",
          availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7" }],
        },
      }
    : {
        sessionId: ACP_SESSION_ID,
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
        models: {
          currentModelId: "gemini-2.5-pro",
          availableModels: [{ modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gemini-2.5-pro",
            options: [{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
          },
        ],
      };

  const entries: Array<ProviderReplayTranscript["entries"][number]> = [
    {
      type: "expect_outbound",
      label: "request:initialize",
      frame: { kind: "request", method: "initialize", params: "<any>" },
    },
    {
      type: "emit_inbound",
      label: "response:initialize",
      frame: { kind: "response", method: "initialize", result: initializeResult },
    },
    {
      type: "expect_outbound",
      label: "request:session/new",
      frame: { kind: "request", method: "session/new", params: "<any>" },
    },
    {
      type: "emit_inbound",
      label: "response:session/new",
      frame: { kind: "response", method: "session/new", result: sessionNewResult },
    },
    {
      type: "expect_outbound",
      label: "request:session/prompt",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
  ];

  if (input.toolCallStart !== undefined) {
    entries.push({
      type: "emit_inbound",
      label: "notification:session/update:tool_call",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: ACP_SESSION_ID,
          update: {
            sessionUpdate: "tool_call",
            ...input.toolCallStart,
          },
        },
      },
    });
  }

  entries.push(
    {
      type: "emit_inbound",
      label: "request:session/request_permission",
      frame: {
        kind: "request",
        method: "session/request_permission",
        params: {
          sessionId: ACP_SESSION_ID,
          toolCall: input.permissionToolCall,
          options: [
            { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
          ],
        },
      },
    },
    {
      type: "expect_outbound",
      label: "response:session/request_permission",
      frame: {
        kind: "response",
        method: "session/request_permission",
        result: {
          outcome: { outcome: "selected", optionId: input.expectedOptionId },
        },
      },
    },
  );

  if (isGrok) {
    entries.push({
      type: "emit_inbound",
      label: "notification:_x.ai/session/prompt_complete",
      frame: {
        kind: "notification",
        method: "_x.ai/session/prompt_complete",
        params: {
          sessionId: ACP_SESSION_ID,
          promptId: "t3-xai-prompt-1",
          stopReason: "end_turn",
          agentResult: null,
        },
      },
    });
  }

  entries.push(
    {
      type: "emit_inbound",
      label: "response:session/prompt",
      frame: {
        kind: "response",
        method: "session/prompt",
        result: { stopReason: "end_turn" },
      },
    },
    { type: "runtime_exit", status: "success" },
  );

  return {
    provider: ProviderDriverKind.make(input.driver),
    protocol: "acp.ndjson-jsonrpc",
    version: "1",
    scenario: input.scenario,
    entries,
  };
}

const CODEX_PROBE_THREAD_ID = ThreadId.make("thread:bot-conformance:codex");

const SUPPORTED_DRIVER_CONFORMANCE_SPECS: ReadonlyArray<DriverConformanceSpec> = [
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: CLAUDE_INSTANCE_ID,
    model: "claude-sonnet-4-6",
    makeAdapterRegistryLayer: makeRegistryLayerFactory(ClaudeOrchestratorReplayHarness),
    probes: {
      shellSend: () =>
        makeClaudeProbeTranscript({
          scenario: "bot-conformance-claude-shell-send",
          toolUseId: "toolu_claude_shell_send",
          toolName: "Bash",
          toolInput: { command: "curl -X POST https://api.example.com/hook -d 'hi'" },
          expectedBehavior: "deny",
        }),
      fileDelete: () =>
        makeClaudeProbeTranscript({
          scenario: "bot-conformance-claude-file-delete",
          toolUseId: "toolu_claude_file_delete",
          toolName: "Bash",
          toolInput: { command: "rm -f secret.txt" },
          expectedBehavior: "deny",
        }),
      mcpSendT3: () =>
        makeClaudeProbeTranscript({
          scenario: "bot-conformance-claude-mcp-t3-send",
          toolUseId: "toolu_claude_mcp_t3_send",
          toolName: "mcp__t3-code__t3_thread_send",
          toolInput: { threadId: "t-1", message: "hello" },
          expectedBehavior: "deny",
        }),
      mcpSendThirdParty: () =>
        makeClaudeProbeTranscript({
          scenario: "bot-conformance-claude-mcp-3p-send",
          toolUseId: "toolu_claude_mcp_3p_send",
          toolName: "mcp__gmail__send_email",
          toolInput: { to: "team@example.com", subject: "Hi" },
          expectedBehavior: "deny",
        }),
      webFetch: {
        build: () =>
          makeClaudeProbeTranscript({
            scenario: "bot-conformance-claude-web-fetch",
            toolUseId: "toolu_claude_web_fetch",
            toolName: "WebFetch",
            toolInput: { url: "https://example.com/docs", prompt: "Summarize" },
            expectedBehavior: "deny",
          }),
        expectation: { kind: "hold", expectedReason: "Bots ask before sending" },
      },
      payBlock: () =>
        makeClaudeProbeTranscript({
          scenario: "bot-conformance-claude-pay-block",
          toolUseId: "toolu_claude_pay_block",
          toolName: "mcp__stripe__stripe_checkout",
          toolInput: { amount: 2500 },
          expectedBehavior: "deny",
          expectedDenyMessage: `The user declined this tool call and said:\n${BOT_PAY_BLOCKED_FEEDBACK}`,
        }),
    },
  },
  {
    driver: ProviderDriverKind.make("codex"),
    instanceId: CODEX_INSTANCE_ID,
    model: "gpt-5",
    makeAdapterRegistryLayer: makeRegistryLayerFactory(CodexOrchestratorReplayHarness),
    probes: {
      shellSend: () =>
        makeCodexBasePrefix({
          scenario: "bot-conformance-codex-shell-send",
          threadId: CODEX_PROBE_THREAD_ID,
          extraTurnEntries: [
            {
              type: "emit_inbound",
              label: "item/started",
              frame: {
                method: "item/started",
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  item: {
                    type: "commandExecution",
                    id: "exec-shell-send",
                    command: "curl -X POST https://api.example.com/hook -d 'hi'",
                    cwd: "<workspace>",
                    status: "inProgress",
                    commandActions: [],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/commandExecution/requestApproval",
              frame: {
                method: "item/commandExecution/requestApproval",
                id: 10,
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  itemId: "exec-shell-send",
                  command: "curl -X POST https://api.example.com/hook -d 'hi'",
                  cwd: "<workspace>",
                },
              },
            },
            {
              type: "expect_outbound",
              label: "item/commandExecution/requestApproval",
              frame: { id: 10, result: { decision: "decline" } },
            },
          ],
        }),
      fileDelete: () =>
        makeCodexBasePrefix({
          scenario: "bot-conformance-codex-file-delete",
          threadId: CODEX_PROBE_THREAD_ID,
          extraTurnEntries: [
            {
              type: "emit_inbound",
              label: "item/started",
              frame: {
                method: "item/started",
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  item: {
                    type: "fileChange",
                    id: "fc-delete",
                    status: "inProgress",
                    changes: [{ path: "secret.txt", kind: { type: "delete" }, diff: "" }],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/fileChange/requestApproval",
              frame: {
                method: "item/fileChange/requestApproval",
                id: 11,
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  itemId: "fc-delete",
                  reason: "Delete secret.txt",
                },
              },
            },
            {
              type: "expect_outbound",
              label: "item/fileChange/requestApproval",
              frame: { id: 11, result: { decision: "decline" } },
            },
          ],
        }),
      mcpSendT3: () =>
        makeCodexBasePrefix({
          scenario: "bot-conformance-codex-mcp-t3-send",
          threadId: CODEX_PROBE_THREAD_ID,
          extraTurnEntries: [
            {
              type: "emit_inbound",
              label: "mcpServer/elicitation/request",
              frame: {
                method: "mcpServer/elicitation/request",
                id: 12,
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  serverName: "t3-code",
                  mode: "form",
                  message: "Allow t3_thread_send to post a message?",
                  requestedSchema: { type: "object", properties: {} },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "mcpServer/elicitation/request",
              frame: { id: 12, result: { action: "decline" } },
            },
          ],
        }),
      mcpSendThirdParty: () =>
        makeCodexBasePrefix({
          scenario: "bot-conformance-codex-mcp-3p-send",
          threadId: CODEX_PROBE_THREAD_ID,
          extraTurnEntries: [
            {
              type: "emit_inbound",
              label: "mcpServer/elicitation/request",
              frame: {
                method: "mcpServer/elicitation/request",
                id: 13,
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  serverName: "gmail",
                  mode: "form",
                  message: "Allow gmail.send_email to send an email?",
                  requestedSchema: { type: "object", properties: {} },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "mcpServer/elicitation/request",
              frame: { id: 13, result: { action: "decline" } },
            },
          ],
        }),
      webFetch: {
        // Codex server-side web_search is disabled via per-thread config on bot runs;
        // the expect_outbound on thread/start asserts `config.web_search === "disabled"`.
        build: () =>
          makeCodexBasePrefix({
            scenario: "bot-conformance-codex-web-search-disabled",
            threadId: CODEX_PROBE_THREAD_ID,
            extraTurnEntries: [],
          }),
        expectation: { kind: "turn_complete" },
      },
      payBlock: () =>
        makeCodexBasePrefix({
          scenario: "bot-conformance-codex-pay-block",
          threadId: CODEX_PROBE_THREAD_ID,
          extraTurnEntries: [
            {
              type: "emit_inbound",
              label: "mcpServer/elicitation/request",
              frame: {
                method: "mcpServer/elicitation/request",
                id: 14,
                params: {
                  threadId: CODEX_THREAD_ID,
                  turnId: CODEX_TURN_ID,
                  serverName: "stripe",
                  mode: "form",
                  message: "Allow stripe_checkout to purchase item?",
                  requestedSchema: { type: "object", properties: {} },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "mcpServer/elicitation/request",
              frame: { id: 14, result: { action: "decline" } },
            },
          ],
        }),
    },
  },
  {
    driver: ProviderDriverKind.make("antigravity"),
    instanceId: ANTIGRAVITY_REPLAY_INSTANCE_ID,
    model: "gemini-2.5-pro",
    makeAdapterRegistryLayer: makeRegistryLayerFactory(AntigravityOrchestratorReplayHarness),
    probes: {
      shellSend: () =>
        makeAcpProbeTranscript({
          driver: "antigravity",
          scenario: "bot-conformance-antigravity-shell-send",
          permissionToolCall: {
            toolCallId: "tc-ag-shell-send",
            kind: "execute",
            title: "Run command",
            rawInput: { command: "curl -X POST https://api.example.com/hook -d 'hi'" },
          },
          expectedOptionId: "reject-once",
        }),
      fileDelete: () =>
        makeAcpProbeTranscript({
          driver: "antigravity",
          scenario: "bot-conformance-antigravity-file-delete",
          permissionToolCall: {
            toolCallId: "tc-ag-delete",
            kind: "delete",
            title: "Delete file",
            locations: [{ path: "<workspace>/secret.txt" }],
          },
          expectedOptionId: "reject-once",
        }),
      mcpSendT3: () =>
        makeAcpProbeTranscript({
          driver: "antigravity",
          scenario: "bot-conformance-antigravity-mcp-t3-send",
          permissionToolCall: {
            toolCallId: "tc-ag-mcp-t3",
            kind: "other",
            title: "MCP Tool t3_thread_send",
            rawInput: {
              ServerName: "t3-code",
              ToolName: "t3_thread_send",
              Arguments: { threadId: "t-1", message: "hi" },
            },
          },
          expectedOptionId: "reject-once",
        }),
      mcpSendThirdParty: () =>
        makeAcpProbeTranscript({
          driver: "antigravity",
          scenario: "bot-conformance-antigravity-mcp-3p-send",
          permissionToolCall: {
            toolCallId: "tc-ag-mcp-3p",
            kind: "other",
            title: "MCP Tool send_email",
            rawInput: { to: "team@example.com" },
          },
          expectedOptionId: "reject-once",
        }),
      webFetch: {
        build: () =>
          makeAcpProbeTranscript({
            driver: "antigravity",
            scenario: "bot-conformance-antigravity-web-fetch",
            permissionToolCall: {
              toolCallId: "tc-ag-fetch",
              kind: "fetch",
              title: "read_url_content",
              rawInput: { url: "https://example.com/docs" },
            },
            expectedOptionId: "reject-once",
          }),
        expectation: { kind: "hold", expectedReason: "Bots ask before sending" },
      },
      payBlock: () =>
        makeAcpProbeTranscript({
          driver: "antigravity",
          scenario: "bot-conformance-antigravity-pay-block",
          permissionToolCall: {
            toolCallId: "tc-ag-pay",
            kind: "other",
            title: "MCP Tool stripe_checkout",
            rawInput: { amount: 2500 },
          },
          expectedOptionId: "reject-once",
        }),
    },
  },
  {
    driver: ProviderDriverKind.make("grok"),
    instanceId: GROK_INSTANCE_ID,
    model: "grok-4.7",
    makeAdapterRegistryLayer: makeRegistryLayerFactory(GrokOrchestratorReplayHarness),
    probes: {
      shellSend: () =>
        makeAcpProbeTranscript({
          driver: "grok",
          scenario: "bot-conformance-grok-shell-send",
          permissionToolCall: {
            toolCallId: "tc-grok-shell-send",
            kind: "execute",
            title: "Execute `curl -X POST https://api.example.com/hook -d 'hi'`",
            rawInput: { command: "curl -X POST https://api.example.com/hook -d 'hi'" },
          },
          expectedOptionId: "reject-once",
        }),
      fileDelete: () =>
        makeAcpProbeTranscript({
          driver: "grok",
          scenario: "bot-conformance-grok-file-delete",
          permissionToolCall: {
            toolCallId: "tc-grok-delete",
            kind: "delete",
            title: "Delete file",
            locations: [{ path: "<workspace>/secret.txt" }],
          },
          expectedOptionId: "reject-once",
        }),
      mcpSendT3: () =>
        makeAcpProbeTranscript({
          driver: "grok",
          scenario: "bot-conformance-grok-mcp-t3-send",
          toolCallStart: {
            toolCallId: "tc-grok-mcp-t3",
            kind: "other",
            title: "use_tool",
            rawInput: {
              tool_name: "t3-code__t3_thread_send",
              args: { threadId: "t-1", message: "hi" },
            },
            _meta: { "x.ai/tool": { name: "use_tool" } },
          },
          permissionToolCall: {
            toolCallId: "tc-grok-mcp-t3",
            kind: "other",
            title: "use_tool",
          },
          expectedOptionId: "reject-once",
        }),
      mcpSendThirdParty: () =>
        makeAcpProbeTranscript({
          driver: "grok",
          scenario: "bot-conformance-grok-mcp-3p-send",
          toolCallStart: {
            toolCallId: "tc-grok-mcp-3p",
            kind: "other",
            title: "use_tool",
            rawInput: { tool_name: "gmail__send_email", args: { to: "team@example.com" } },
            _meta: { "x.ai/tool": { name: "use_tool" } },
          },
          permissionToolCall: {
            toolCallId: "tc-grok-mcp-3p",
            kind: "other",
            title: "use_tool",
          },
          expectedOptionId: "reject-once",
        }),
      webFetch: {
        build: () =>
          makeAcpProbeTranscript({
            driver: "grok",
            scenario: "bot-conformance-grok-web-fetch",
            permissionToolCall: {
              toolCallId: "tc-grok-fetch",
              kind: "fetch",
              title: "WebFetch",
              rawInput: { url: "https://example.com/docs" },
            },
            expectedOptionId: "reject-once",
          }),
        expectation: { kind: "hold", expectedReason: "Bots ask before sending" },
      },
      payBlock: () =>
        makeAcpProbeTranscript({
          driver: "grok",
          scenario: "bot-conformance-grok-pay-block",
          toolCallStart: {
            toolCallId: "tc-grok-pay",
            kind: "other",
            title: "use_tool",
            rawInput: { tool_name: "stripe__stripe_checkout", args: { amount: 2500 } },
            _meta: { "x.ai/tool": { name: "use_tool" } },
          },
          permissionToolCall: {
            toolCallId: "tc-grok-pay",
            kind: "other",
            title: "use_tool",
          },
          expectedOptionId: "reject-once",
        }),
    },
  },
];

class BotConformanceProbeError extends Schema.TaggedError<BotConformanceProbeError>()(
  "BotConformanceProbeError",
  {
    message: Schema.String,
  },
) {}

const runBotConformanceProbe = Effect.fn("BotConformance.runProbe")(function* (input: {
  readonly spec: DriverConformanceSpec;
  readonly probeName: string;
  readonly transcript: ProviderReplayTranscript;
  readonly expectation: ProbeExpectation;
  readonly threadId?: ThreadId;
}) {
  const { spec, probeName, expectation } = input;
  const scenarioName = `${spec.driver}-${probeName}`;
  const workspace = yield* checkpointWorkspace(scenarioName).pipe(Effect.orDie);
  const materializedTranscript =
    spec.driver === "codex"
      ? materializeReplayTranscriptWorkspace(input.transcript, workspace)
      : input.transcript;
  const registryLayer = yield* spec.makeAdapterRegistryLayer(materializedTranscript);
  const threadId = input.threadId ?? ThreadId.make(`thread:bot-conformance:${scenarioName}`);

  const layerDatabase = SqlitePersistence.layerMemory;
  const layerServerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(scenarioName).pipe(Effect.orDie),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const layerServerSettings = ServerSettings.layerTest({
    botsEnabled: true,
    responseStreamingMode: "turn",
    projectSettingsOverrides: {
      [BOT_PROJECT_ID]: { bot: {} },
    },
  });
  const layerProviderInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      instanceId === spec.instanceId
        ? makeSnapshotInstance(spec.instanceId, spec.driver)
        : Effect.undefined,
  });
  const layerEffectOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const layerStores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    CommandReceiptStore.layer,
    layerEffectOutbox,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provide(layerDatabase));
  const layerEventSink = EventSink.layerFromStores.pipe(
    Layer.provide(Layer.mergeAll(layerStores, layerDatabase, ThreadViewers.layer)),
  );
  const layerWorkspaceFolders = WorkspaceFolders.layer.pipe(
    Layer.provide(layerStores),
    Layer.provide(TaskFolderStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerRuntimePolicy = RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerStores,
        layerServerSettings,
        layerWorkspaceFolders,
        layerProviderInstances,
      ),
    ),
  );
  const layerProvidedRegistry = registryLayer.pipe(
    Layer.provide(Layer.merge(ProviderContinuationRequests.layer, McpProviderSessions.layer)),
  );
  const layerProviderEventIngestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerProviderInstances,
        layerStores,
        layerEventSink,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        GitVcsDriver.layer.pipe(
          Layer.provide(layerServerConfig),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(layerServerConfig),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerCheckpointService = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CheckpointStore.layer.pipe(
          Layer.provide(layerVcsDriverRegistry),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
        IdAllocator.layer,
        layerWorkspaceFolders,
      ),
    ),
  );
  const layerContextHandoff = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));
  const layerCommandOutputHub = CommandOutputRecorder.layer.pipe(
    Layer.provide(Layer.merge(layerEventSink, layerStores)),
  );
  const layerProviderSessionManager = ProviderSessionManager.layerWithOptions({
    configureMcp: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCommandOutputHub,
        layerProvidedRegistry,
        layerEventSink,
        IdAllocator.layer,
        McpProviderSessions.layer,
        McpSessionRegistryTestkit.layer,
        layerProviderEventIngestor,
        layerStores,
        ProviderInstallationGate.layer,
      ),
    ),
  );
  const layerRunExecution = RunExecutionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        McpAppModelContext.layerEmpty,
        PreviewAgentActivity.layer,
        layerCheckpointService,
        layerEventSink,
        IdAllocator.layer,
        layerProviderEventIngestor,
        layerServerSettings,
        layerStores,
        ThreadCommandExecutor.layer,
      ),
    ),
  );
  const layerProviderTurnStart = ProviderTurnStartService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerContextHandoff,
        layerEventSink,
        IdAllocator.layer,
        layerStores,
        layerProviderSessionManager,
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        layerRunExecution,
        layerRuntimePolicy,
        layerServerConfig,
        layerServerSettings,
        Layer.mock(ThreadWorktreeRestore)({ takeRecreated: () => Effect.undefined }),
      ),
    ),
  );
  const layerProviderTurnControl = ProviderTurnControlService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerEventSink,
        McpAppModelContext.layerEmpty,
        layerStores,
        layerProviderSessionManager,
      ),
    ),
  );
  const layerRuntimeRequest = RuntimeRequestService.layer.pipe(
    Layer.provide(Layer.merge(layerStores, layerProviderSessionManager)),
  );
  const layerCheckpointRollback = CheckpointRollbackService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCheckpointService,
        layerEventSink,
        IdAllocator.layer,
        layerStores,
        layerProviderSessionManager,
        ThreadCommandExecutor.layer,
        layerRuntimePolicy,
        layerServerConfig,
        layerServerSettings,
      ),
    ),
  );
  const layerCheckpointCapture = CheckpointCaptureService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCheckpointService,
        layerEventSink,
        IdAllocator.layer,
        layerStores,
        ThreadCommandExecutor.layer,
      ),
    ),
  );
  const layerRunFinalization = RunFinalizationService.layer.pipe(
    Layer.provide(Layer.merge(layerCheckpointCapture, layerStores)),
  );
  const layerTitleRegen = Layer.succeed(
    ThreadTitleRegenerationService.ThreadTitleRegenerationService,
    ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
      execute: () => Effect.void,
    }),
  );
  const layerOrchestrator = Orchestrator.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCheckpointService,
        CommandPolicy.layer,
        layerContextHandoff,
        layerStores,
        layerEventSink,
        IdAllocator.layer,
        layerProviderEventIngestor,
        layerProvidedRegistry,
        ProviderContinuationRequests.layer,
        layerRuntimePolicy,
        layerProviderSessionManager,
        ProviderSwitchService.layer.pipe(Layer.provide(layerProvidedRegistry)),
        layerRunExecution,
        layerServerSettings,
        TaskFolderStore.layer.pipe(Layer.provide(layerDatabase)),
        ThreadForkService.layer,
      ),
    ),
  );
  const layerThreadManagement = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
        getThreadProjection: orchestrator.getThreadProjection,
        recoverDelegatedTask: orchestrator.recoverDelegatedTask,
        cancelDelegatedTask: orchestrator.cancelDelegatedTask,
        delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
        streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
      });
    }),
  ).pipe(Layer.provide(layerOrchestrator));
  const layerEffectExecutor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRunFinalization,
        layerCheckpointRollback,
        layerProviderSessionManager,
        layerProviderTurnControl,
        layerProviderTurnStart,
        layerRuntimeRequest,
        layerTitleRegen,
        layerServerSettings,
        layerThreadManagement,
        layerStores,
        ProjectionMaintenance.layer.pipe(Layer.provide(layerDatabase)),
      ),
    ),
  );
  const layerEffectWorker = EffectWorker.layer.pipe(
    Layer.provide(Layer.merge(layerStores, layerEffectExecutor)),
  );
  const layerBotGate = BotActionGateReactor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerOrchestrator, layerStores, layerEventSink, layerServerSettings),
    ),
    Layer.provide(NodeCrypto.layer),
  );

  const fullLayer = Layer.mergeAll(
    layerOrchestrator,
    layerEffectWorker,
    layerStores,
    layerBotGate,
  ).pipe(
    Layer.provide(ProviderTurnStartServiceTestkit.layer),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const botGate = yield* BotActionGateReactor.BotActionGateReactor;

    yield* projectStore.apply({
      type: "project.created",
      sequence: 1,
      eventId: EventId.make(`ev:project:${scenarioName}`),
      aggregateKind: "project",
      aggregateId: BOT_PROJECT_ID,
      occurredAt: "2026-10-01T12:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId: BOT_PROJECT_ID,
        title: "Bot conformance",
        workspaceRoot: workspace,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
    });

    const heldApproval = yield* Deferred.make<
      Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }>,
      BotConformanceProbeError
    >();
    const autoResolved = yield* Deferred.make<
      {
        readonly requestId: RuntimeRequestId;
        readonly decision: string | undefined;
      },
      BotConformanceProbeError
    >();
    const runFinished = yield* Deferred.make<void, BotConformanceProbeError>();

    const watcher = yield* Stream.runForEach(
      orchestrator.streamDomainEvents,
      (event: OrchestrationV2DomainEvent) =>
        Effect.gen(function* () {
          if (event.threadId !== threadId) return;
          if (
            expectation.kind === "hold" &&
            event.type === "turn-item.updated" &&
            event.payload.type === "approval_request" &&
            event.payload.status === "waiting" &&
            event.payload.reason === expectation.expectedReason
          ) {
            yield* Deferred.succeed(heldApproval, event.payload);
          }
          if (
            (expectation.kind === "block_pay" || expectation.kind === "auto_allow") &&
            event.type === "runtime-request.updated" &&
            event.payload.status === "resolved"
          ) {
            yield* Deferred.succeed(autoResolved, {
              requestId: event.payload.id,
              decision: event.payload.decision,
            });
          }
          if (event.type === "run.updated") {
            if (event.payload.status === "failed" || event.payload.status === "interrupted") {
              const projection = yield* orchestrator.getThreadProjection(threadId);
              const err = new BotConformanceProbeError({
                message: `Bot conformance probe ${scenarioName} ended with run status ${event.payload.status}: ${JSON.stringify(event.payload)} items=${JSON.stringify(projection.turnItems)}`,
              });
              yield* Deferred.fail(heldApproval, err);
              yield* Deferred.fail(autoResolved, err);
              yield* Deferred.fail(runFinished, err);
            } else if (event.payload.status === "completed") {
              const unexpectedEnd = new BotConformanceProbeError({
                message: `Bot conformance probe ${scenarioName} completed without expected gate action`,
              });
              yield* Deferred.fail(heldApproval, unexpectedEnd);
              yield* Deferred.fail(autoResolved, unexpectedEnd);
              yield* Deferred.succeed(runFinished, undefined);
            }
          }
        }),
    ).pipe(Effect.forkScoped);

    yield* botGate.start();
    const workerFiber = yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);

    // Deliberately store thread as full-access so RuntimePolicy must clamp it on turn start.
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd:create:${scenarioName}`),
      threadId,
      projectId: BOT_PROJECT_ID,
      title: "Bot conformance",
      modelSelection: { instanceId: spec.instanceId, model: spec.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: workspace,
      createdBy: "user",
      creationSource: "server",
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`cmd:msg:${scenarioName}`),
      threadId,
      messageId: MessageId.make(`msg:${scenarioName}`),
      text: PROBE_PROMPT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });

    const awaitWithDiag = <A>(stage: string, effect: Effect.Effect<A, BotConformanceProbeError>) =>
      effect.pipe(
        Effect.timeoutOption("15 seconds"),
        Effect.flatMap((option) =>
          option._tag === "Some"
            ? Effect.succeed(option.value)
            : orchestrator.getThreadProjection(threadId).pipe(
                Effect.flatMap((projection) =>
                  Effect.fail(
                    new BotConformanceProbeError({
                      message: `Timed out waiting for ${stage} in ${scenarioName}. runs=${JSON.stringify(projection.runs)} requests=${JSON.stringify(projection.runtimeRequests)} items=${JSON.stringify(projection.turnItems)}`,
                    }),
                  ),
                ),
              ),
        ),
      );

    if (expectation.kind === "hold") {
      const approvalItem = yield* awaitWithDiag("heldApproval", Deferred.await(heldApproval));
      expect(approvalItem.reason).toBe(expectation.expectedReason);
      expect(approvalItem.options).toEqual(BOT_HELD_APPROVAL_OPTIONS);
      expect(approvalItem.fullAccessOverride).toBeUndefined();

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const pendingRequest = projection.runtimeRequests.find(
        (candidate) => candidate.id === approvalItem.requestId,
      );
      expect(pendingRequest?.status).toBe("pending");

      // Respond decline so the replay turn finishes cleanly and consumes all frames.
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`cmd:decline:${scenarioName}`),
        threadId,
        requestId: approvalItem.requestId,
        decision: "decline",
      });
      yield* awaitWithDiag("runFinished", Deferred.await(runFinished));
    } else if (expectation.kind === "block_pay") {
      const resolved = yield* awaitWithDiag("block_pay", Deferred.await(autoResolved));
      expect(resolved.decision).toBe("decline");
      yield* awaitWithDiag("runFinished", Deferred.await(runFinished));
    } else if (expectation.kind === "auto_allow") {
      const resolved = yield* awaitWithDiag("auto_allow", Deferred.await(autoResolved));
      expect(resolved.decision).toBe("accept");
      yield* awaitWithDiag("runFinished", Deferred.await(runFinished));
    } else {
      yield* awaitWithDiag("runFinished", Deferred.await(runFinished));
    }

    yield* Fiber.interrupt(watcher);
    yield* Fiber.interrupt(workerFiber);
  }).pipe(Effect.provide(fullLayer), Effect.scoped);
});

describe("bot provider conformance", () => {
  it.effect(
    "declares botGate on every BUILT_IN_DRIVERS entry, covers every supported driver in the conformance table, and refuses every unsupported driver with its reasonCode",
    () =>
      Effect.gen(function* () {
        const expectedSupported = new Set(["claudeAgent", "codex", "antigravity", "grok"]);
        const expectedUnsupportedReasons: Readonly<Record<string, BotGateUnsupportedReasonCode>> = {
          cursor: "no_approval_callback",
          opencode: "ungated_mcp_or_tools",
          pi: "ungated_mcp_or_tools",
          kiro: "unisolated_user_rules",
          muse: "unisolated_user_rules",
          fx: "opaque_subagents_or_mcp",
          acpRegistry: "unverified_third_party_acp",
        };

        for (const driver of BUILT_IN_DRIVERS) {
          expect(driver.metadata.botGate).toBeDefined();
        }

        const supportedFromBuiltIns = BUILT_IN_DRIVERS.filter(
          (driver) => driver.metadata.botGate?.status === "supported",
        ).map((driver) => driver.driverKind);
        expect(new Set(supportedFromBuiltIns)).toEqual(expectedSupported);
        expect(new Set(SUPPORTED_DRIVER_CONFORMANCE_SPECS.map((spec) => spec.driver))).toEqual(
          new Set(supportedFromBuiltIns),
        );

        const unsupportedDrivers = BUILT_IN_DRIVERS.filter(
          (driver) => driver.metadata.botGate?.status === "unsupported",
        );
        expect(unsupportedDrivers.length).toBe(Object.keys(expectedUnsupportedReasons).length);

        const settingsLayer = ServerSettings.layerTest({
          botsEnabled: true,
          projectSettingsOverrides: {
            [BOT_PROJECT_ID]: { bot: {} },
          },
        });
        const driverByInstance = new Map(
          unsupportedDrivers.map((driver) => [
            ProviderInstanceId.make(`inst-${driver.driverKind}`),
            driver.driverKind,
          ]),
        );
        const runtimePolicyLayer = RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(
            Layer.mergeAll(
              settingsLayer,
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: (projectId) =>
                  Effect.succeedSome({
                    projectId,
                    title: "Bot",
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
                  const driver = driverByInstance.get(instanceId);
                  if (driver === undefined) return Effect.undefined;
                  return makeSnapshotInstance(instanceId, driver);
                },
              }),
            ),
          ),
        );

        const now = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z");
        const threadId = ThreadId.make("thread:exhaustiveness");
        const policy = yield* RuntimePolicy.RuntimePolicyV2.pipe(
          Effect.provide(runtimePolicyLayer),
        );

        for (const driver of unsupportedDrivers) {
          const instanceId = ProviderInstanceId.make(`inst-${driver.driverKind}`);
          const failure = yield* policy
            .resolve({
              thread: {
                id: threadId,
                projectId: BOT_PROJECT_ID,
                title: "Exhaustiveness",
                branch: null,
                worktreePath: "/tmp/workspace",
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "test-model" },
                runtimeMode: "full-access",
                interactionMode: "default",
                activeProviderThreadId: null,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdBy: "user",
                creationSource: "server",
                pinnedAt: null,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                deletedAt: null,
                createdAt: now,
                updatedAt: now,
              },
              modelSelection: { instanceId, model: "test-model" },
            })
            .pipe(Effect.flip);
          expect(failure._tag).toBe("RuntimePolicyBotProviderUnsupportedError");
          if (failure._tag === "RuntimePolicyBotProviderUnsupportedError") {
            expect(failure.reasonCode).toBe(expectedUnsupportedReasons[driver.driverKind]);
          }
        }
      }).pipe(Effect.scoped),
  );

  describe.each(SUPPORTED_DRIVER_CONFORMANCE_SPECS)("driver: $driver", (spec) => {
    const threadId = spec.driver === "codex" ? CODEX_PROBE_THREAD_ID : undefined;

    it.live("holds shell send commands without session-wide approval options", () =>
      runBotConformanceProbe({
        spec,
        probeName: "shell-send",
        transcript: spec.probes.shellSend(),
        expectation: { kind: "hold", expectedReason: "Bots ask before sending" },
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );

    it.live("holds file deletes without session-wide approval options", () =>
      runBotConformanceProbe({
        spec,
        probeName: "file-delete",
        transcript: spec.probes.fileDelete(),
        expectation: { kind: "hold", expectedReason: "Bots ask before deleting" },
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );

    it.live("holds T3 MCP send tools without auto-approving them", () =>
      runBotConformanceProbe({
        spec,
        probeName: "mcp-t3-send",
        transcript: spec.probes.mcpSendT3(),
        expectation: { kind: "hold", expectedReason: "Bots ask before sending" },
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );

    it.live("holds third-party MCP send tools without auto-approving them", () =>
      runBotConformanceProbe({
        spec,
        probeName: "mcp-3p-send",
        transcript: spec.probes.mcpSendThirdParty(),
        expectation: { kind: "hold", expectedReason: "Bots ask before sending" },
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );

    it.live("holds web fetches (or disables server-side web_search on Codex)", () =>
      runBotConformanceProbe({
        spec,
        probeName: "web-fetch",
        transcript: spec.probes.webFetch.build(),
        expectation: spec.probes.webFetch.expectation,
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );

    it.live("blocks pay tools automatically without asking the user", () =>
      runBotConformanceProbe({
        spec,
        probeName: "pay-block",
        transcript: spec.probes.payBlock(),
        expectation: { kind: "block_pay" },
        ...(threadId === undefined ? {} : { threadId }),
      }),
    );
  });

  it.live(
    "holds edits under .gemini/ (Antigravity) and .grok/ (Grok) as agent settings, and auto-allows plain ACP reads through the bot gate",
    () =>
      Effect.gen(function* () {
        const antigravitySpec = SUPPORTED_DRIVER_CONFORMANCE_SPECS.find(
          (spec) => spec.driver === "antigravity",
        )!;
        const grokSpec = SUPPORTED_DRIVER_CONFORMANCE_SPECS.find((spec) => spec.driver === "grok")!;

        yield* runBotConformanceProbe({
          spec: antigravitySpec,
          probeName: "agent-settings-gemini",
          transcript: makeAcpProbeTranscript({
            driver: "antigravity",
            scenario: "bot-conformance-antigravity-agent-settings",
            permissionToolCall: {
              toolCallId: "tc-ag-settings",
              kind: "edit",
              title: "Edit file",
              locations: [{ path: "/home/user/.gemini/settings.json" }],
            },
            expectedOptionId: "reject-once",
          }),
          expectation: { kind: "hold", expectedReason: "Bots ask before changing agent settings" },
        });

        yield* runBotConformanceProbe({
          spec: grokSpec,
          probeName: "agent-settings-grok",
          transcript: makeAcpProbeTranscript({
            driver: "grok",
            scenario: "bot-conformance-grok-agent-settings",
            permissionToolCall: {
              toolCallId: "tc-grok-settings",
              kind: "edit",
              title: "Edit file",
              locations: [{ path: "/home/user/.grok/settings.json" }],
            },
            expectedOptionId: "reject-once",
          }),
          expectation: { kind: "hold", expectedReason: "Bots ask before changing agent settings" },
        });

        yield* runBotConformanceProbe({
          spec: antigravitySpec,
          probeName: "plain-read",
          transcript: makeAcpProbeTranscript({
            driver: "antigravity",
            scenario: "bot-conformance-antigravity-plain-read",
            permissionToolCall: {
              toolCallId: "tc-ag-read",
              kind: "read",
              title: "Read notes.md",
              locations: [{ path: "<workspace>/notes.md" }],
            },
            expectedOptionId: "allow-once",
          }),
          expectation: { kind: "auto_allow" },
        });
      }),
  );
});
