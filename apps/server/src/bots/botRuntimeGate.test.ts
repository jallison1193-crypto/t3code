import { describe, expect, it } from "@effect/vitest";
import {
  BOT_UNSUPPORTED_PROVIDER_REASON,
  EnvironmentId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const NOW = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z");
const BOT_PROJECT = ProjectId.make("project:bot-runtime");
const ORDINARY_PROJECT = ProjectId.make("project:ordinary-runtime");

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
) {
  const settingsLayer = ServerSettings.layerTest({
    botsEnabled: true,
    projectSettingsOverrides: {
      [BOT_PROJECT]: { bot: {} },
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

        const botClaudePolicy = yield* policy.resolve({
          thread: botThread,
          modelSelection: claudeSelection,
        });
        expect(botClaudePolicy.runtimeMode).toBe("approval-required");
        expect(botClaudePolicy.maxRuntimeMode).toBe("approval-required");
        expect(botClaudePolicy.gateAllMcpTools).toBe(true);
        // Stored thread field stays untouched.
        expect(botThread.runtimeMode).toBe("full-access");

        const botCodexPolicy = yield* policy.resolve({
          thread: botThread,
          modelSelection: codexSelection,
        });
        expect(botCodexPolicy.runtimeMode).toBe("approval-required");
        expect(botCodexPolicy.maxRuntimeMode).toBe("approval-required");
        expect(botCodexPolicy.gateAllMcpTools).toBe(true);

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

  it.effect("refuses bot turns on unsupported providers with a clear message", () =>
    Effect.gen(function* () {
      const unsupportedDrivers: ReadonlyArray<ProviderDriverKind> = [
        ProviderDriverKind.make("cursor"),
        ProviderDriverKind.make("opencode"),
        ProviderDriverKind.make("pi"),
        ProviderDriverKind.make("antigravity"),
        ProviderDriverKind.make("grok"),
        ProviderDriverKind.make("kiro"),
        ProviderDriverKind.make("fx"),
        ProviderDriverKind.make("muse"),
        ProviderDriverKind.make("acpRegistry"),
      ];
      const driversByInstance = Object.fromEntries(
        unsupportedDrivers.map((driver) => [`inst-${driver}`, driver]),
      );
      const { policy } = yield* makeHarness(driversByInstance);
      const botThread = makeThread(BOT_PROJECT, "full-access");
      const ordinaryThread = makeThread(ORDINARY_PROJECT, "full-access");

      for (const driver of unsupportedDrivers) {
        const selection = {
          instanceId: ProviderInstanceId.make(`inst-${driver}`),
          model: "test-model",
        };
        const failure = yield* policy
          .resolve({ thread: botThread, modelSelection: selection })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("RuntimePolicyBotProviderUnsupportedError");
        expect(failure.message).toBe(BOT_UNSUPPORTED_PROVIDER_REASON);

        // Ordinary projects still run on those providers without error.
        const ordinaryResolved = yield* policy.resolve({
          thread: ordinaryThread,
          modelSelection: selection,
        });
        expect(ordinaryResolved.runtimeMode).toBe("full-access");
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
});
