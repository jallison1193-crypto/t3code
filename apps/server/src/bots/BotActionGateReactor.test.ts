import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRequestKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotActionGateReactor from "./BotActionGateReactor.ts";
import { BOT_HELD_APPROVAL_OPTIONS, BOT_PAY_BLOCKED_FEEDBACK } from "./botActionPolicy.ts";

const NOW = DateTime.makeUnsafe("2026-10-01T12:00:00.000Z");
const BOT_PROJECT = ProjectId.make("project:bot-gate");
const ORDINARY_PROJECT = ProjectId.make("project:ordinary-gate");
const BOT_THREAD = ThreadId.make("thread:bot-run-1");
const ORDINARY_THREAD = ThreadId.make("thread:ordinary-1");
const RUN_ID = RunId.make("run:1");
const PROVIDER_THREAD_ID = ProviderThreadId.make("pthread:1");
const PROVIDER_TURN_ID = ProviderTurnId.make("pturn:1");
const PROVIDER_SESSION_ID = ProviderSessionId.make("psess:1");
const PARENT_NODE_ID = NodeId.make("node:parent-tool");
const APPROVAL_NODE_ID = NodeId.make("node:approval");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

function makeThread(threadId: ThreadId, projectId: ProjectId): OrchestrationV2AppThread {
  return {
    id: threadId,
    projectId,
    title: "Test thread",
    branch: null,
    worktreePath: null,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeProviderThreadId: PROVIDER_THREAD_ID,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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

interface HarnessOptions {
  readonly botsEnabled?: boolean;
  readonly botApprovals?: "t3_gate" | "provider";
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  readonly requestKind?: ProviderRequestKind | "user_input";
  readonly requestStatus?: OrchestrationV2RuntimeRequest["status"];
  readonly supportsFeedback?: boolean;
  readonly prompt?: string;
  readonly includeApprovalItem?: boolean;
  readonly siblingItems?: ReadonlyArray<OrchestrationV2TurnItem>;
}

const makeHarness = Effect.fn("BotActionGateReactorTest.makeHarness")(function* (
  options: HarnessOptions = {},
) {
  const threadId = options.threadId ?? BOT_THREAD;
  const projectId = options.projectId ?? BOT_PROJECT;
  const requestId = RuntimeRequestId.make("req:1");
  const requestKind = options.requestKind ?? "command";

  const dispatchedRef = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const writtenEventsRef = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);

  const requestRef = yield* Ref.make<OrchestrationV2RuntimeRequest>({
    id: requestId,
    nodeId: APPROVAL_NODE_ID,
    providerTurnId: PROVIDER_TURN_ID,
    nativeRequestRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
    kind: requestKind,
    status: options.requestStatus ?? "pending",
    responseCapability: {
      type: "live",
      providerSessionId: PROVIDER_SESSION_ID,
      ...(options.supportsFeedback === true ? { supportsFeedback: true } : {}),
    },
    createdAt: NOW,
    resolvedAt: null,
  });

  const approvalNode: OrchestrationV2ExecutionNode = {
    id: APPROVAL_NODE_ID,
    threadId,
    runId: RUN_ID,
    parentNodeId: PARENT_NODE_ID,
    rootNodeId: NodeId.make("node:root"),
    kind: requestKind === "user_input" ? "user_input_request" : "approval_request",
    status: "waiting",
    countsForRun: false,
    providerThreadId: PROVIDER_THREAD_ID,
    providerTurnId: PROVIDER_TURN_ID,
    nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
    runtimeRequestId: requestId,
    checkpointScopeId: null,
    startedAt: NOW,
    completedAt: null,
  };

  const initialApprovalItem: OrchestrationV2TurnItem | undefined =
    options.includeApprovalItem === false
      ? undefined
      : requestKind === "user_input"
        ? {
            id: TurnItemId.make("item:user-input"),
            threadId,
            runId: RUN_ID,
            nodeId: APPROVAL_NODE_ID,
            providerThreadId: PROVIDER_THREAD_ID,
            providerTurnId: PROVIDER_TURN_ID,
            nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
            parentItemId: null,
            ordinal: 2,
            status: "waiting",
            title: null,
            startedAt: NOW,
            completedAt: null,
            updatedAt: NOW,
            type: "user_input_request",
            requestId,
            questions: [
              { id: "q1", header: "Choice", question: "Pick one", options: [], required: true },
            ],
          }
        : {
            id: TurnItemId.make("item:approval"),
            threadId,
            runId: RUN_ID,
            nodeId: APPROVAL_NODE_ID,
            providerThreadId: PROVIDER_THREAD_ID,
            providerTurnId: PROVIDER_TURN_ID,
            nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
            parentItemId: null,
            ordinal: 2,
            status: "waiting",
            title: null,
            startedAt: NOW,
            completedAt: null,
            updatedAt: NOW,
            type: "approval_request",
            requestId,
            requestKind,
            ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
            fullAccessOverride: "ask_rule",
            options: [
              { decision: "decline", label: "Decline" },
              { decision: "accept", label: "Approve once" },
              { decision: "acceptForSession", label: "Allow for session" },
              { decision: "acceptAlways", label: "Always allow" },
            ],
          };

  const approvalItemRef = yield* Ref.make<OrchestrationV2TurnItem | undefined>(initialApprovalItem);
  const thread = makeThread(threadId, projectId);
  const siblings = options.siblingItems ?? [];

  const deps = Layer.mergeAll(
    NodeCrypto.layer,
    ServerSettings.layerTest({
      botsEnabled: options.botsEnabled ?? true,
      projectSettingsOverrides: {
        [BOT_PROJECT]: {
          bot: options.botApprovals === undefined ? {} : { approvals: options.botApprovals },
        },
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(dispatchedRef, (list) => [...list, command]);
          if (command.type === "runtime-request.respond") {
            yield* Ref.update(requestRef, (current) => ({
              ...current,
              status: "resolved" as const,
              resolvedAt: NOW,
              ...(command.decision === undefined ? {} : { decision: command.decision }),
              ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
            }));
          }
          return {
            sequence: 1,
            storedEvents: [],
          };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () => Effect.succeed(thread),
      getRuntimeResponseContext: () =>
        Effect.gen(function* () {
          return {
            request: yield* Ref.get(requestRef),
            node: approvalNode,
            item: yield* Ref.get(approvalItemRef),
            session: undefined,
          };
        }),
      getThreadRecords: () =>
        Effect.gen(function* () {
          const item = yield* Ref.get(approvalItemRef);
          const request = yield* Ref.get(requestRef);
          return {
            thread,
            runs: [],
            attempts: [],
            nodes: [approvalNode],
            subagents: [],
            providerSessions: [],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [request],
            messages: [],
            plans: [],
            turnItems: item === undefined ? [...siblings] : [...siblings, item],
            visibleTurnItems: [],
            checkpointScopes: [],
            checkpoints: [],
            contextHandoffs: [],
            contextTransfers: [],
            pullRequests: [],
            issues: [],
            updatedAt: NOW,
          };
        }),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(writtenEventsRef, (list) => [...list, ...input.events]);
          for (const ev of input.events) {
            if (ev.type === "turn-item.updated" && ev.payload.type === "approval_request") {
              yield* Ref.set(approvalItemRef, ev.payload);
            }
          }
          return [];
        }),
    }),
  );

  const ctx = yield* Layer.build(BotActionGateReactor.layer.pipe(Layer.provideMerge(deps)));
  const reactor = yield* BotActionGateReactor.BotActionGateReactor.pipe(Effect.provide(ctx));

  const runtimeRequestEvent = (): Effect.Effect<OrchestrationV2DomainEvent> =>
    Effect.map(Ref.get(requestRef), (payload) => ({
      id: EventId.make("ev:req-1"),
      type: "runtime-request.updated" as const,
      threadId,
      runId: RUN_ID,
      nodeId: APPROVAL_NODE_ID,
      occurredAt: NOW,
      payload,
    }));

  const turnItemEvent = (): Effect.Effect<OrchestrationV2DomainEvent> =>
    Effect.map(Ref.get(approvalItemRef), (payload) => ({
      id: EventId.make("ev:item-1"),
      type: "turn-item.updated" as const,
      threadId,
      runId: RUN_ID,
      nodeId: APPROVAL_NODE_ID,
      occurredAt: NOW,
      payload: payload!,
    }));

  return {
    reactor,
    requestId,
    threadId,
    dispatchedRef,
    writtenEventsRef,
    approvalItemRef,
    runtimeRequestEvent,
    turnItemEvent,
  };
});

describe("BotActionGateReactor", () => {
  it.effect("auto-accepts allowed actions with a deterministic commandId and ignores replays", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        requestKind: "command",
        prompt: "git status",
      });

      const ev = yield* h.runtimeRequestEvent();
      yield* h.reactor.handle(ev);
      // Replay of the same event must not answer twice.
      yield* h.reactor.handle(ev);

      const dispatched = yield* Ref.get(h.dispatchedRef);
      expect(dispatched).toEqual([
        {
          type: "runtime-request.respond",
          commandId: CommandId.make(`server:bot-action-gate:${h.threadId}:${h.requestId}`),
          threadId: h.threadId,
          requestId: h.requestId,
          decision: "accept",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "holds send actions pending with a reason and only Approve once / Decline options",
    () =>
      Effect.gen(function* () {
        const toolItem: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item:tool-1"),
          threadId: BOT_THREAD,
          runId: RUN_ID,
          nodeId: PARENT_NODE_ID,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: PROVIDER_TURN_ID,
          nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: null,
          startedAt: NOW,
          completedAt: null,
          updatedAt: NOW,
          type: "dynamic_tool",
          toolName: "mcp__gmail__send_message",
          input: { to: "team@example.com" },
        };
        const h = yield* makeHarness({
          requestKind: "permission",
          prompt: "Send email to team@example.com",
          siblingItems: [toolItem],
        });

        const ev = yield* h.runtimeRequestEvent();
        yield* h.reactor.handle(ev);
        // Re-handling the updated turn-item event must be a no-op (no infinite loop).
        yield* h.reactor.handle(yield* h.turnItemEvent());

        expect(yield* Ref.get(h.dispatchedRef)).toEqual([]);
        const written = yield* Ref.get(h.writtenEventsRef);
        expect(written).toHaveLength(1);
        const updated = yield* Ref.get(h.approvalItemRef);
        expect(updated?.type).toBe("approval_request");
        if (updated?.type === "approval_request") {
          expect(updated.reason).toBe("Bots ask before sending");
          expect(updated.options).toEqual(BOT_HELD_APPROVAL_OPTIONS);
          expect(updated.fullAccessOverride).toBeUndefined();
        }
      }).pipe(Effect.scoped),
  );

  it.effect("holds delete actions pending with a delete reason and restricted options", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        requestKind: "command",
        prompt: "rm -rf ./old-notes",
      });

      yield* h.reactor.handle(yield* h.runtimeRequestEvent());

      expect(yield* Ref.get(h.dispatchedRef)).toEqual([]);
      const updated = yield* Ref.get(h.approvalItemRef);
      expect(updated?.type).toBe("approval_request");
      if (updated?.type === "approval_request") {
        expect(updated.reason).toBe("Bots ask before deleting");
        expect(updated.options).toEqual(BOT_HELD_APPROVAL_OPTIONS);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "declines pay actions with feedback when supported, and without feedback when unsupported",
    () =>
      Effect.gen(function* () {
        const payTool: OrchestrationV2TurnItem = {
          id: TurnItemId.make("item:pay-1"),
          threadId: BOT_THREAD,
          runId: RUN_ID,
          nodeId: PARENT_NODE_ID,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: PROVIDER_TURN_ID,
          nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: null,
          startedAt: NOW,
          completedAt: null,
          updatedAt: NOW,
          type: "dynamic_tool",
          toolName: "stripe_checkout",
          input: { amount: 2500 },
        };

        const withFeedback = yield* makeHarness({
          requestKind: "permission",
          supportsFeedback: true,
          siblingItems: [payTool],
        });
        yield* withFeedback.reactor.handle(yield* withFeedback.runtimeRequestEvent());
        expect(yield* Ref.get(withFeedback.dispatchedRef)).toEqual([
          {
            type: "runtime-request.respond",
            commandId: CommandId.make(
              `server:bot-action-gate:${withFeedback.threadId}:${withFeedback.requestId}`,
            ),
            threadId: withFeedback.threadId,
            requestId: withFeedback.requestId,
            decision: "decline",
            feedback: BOT_PAY_BLOCKED_FEEDBACK,
          },
        ]);

        const withoutFeedback = yield* makeHarness({
          requestKind: "command",
          supportsFeedback: false,
          prompt: "stripe charges create --amount=2500",
        });
        yield* withoutFeedback.reactor.handle(yield* withoutFeedback.runtimeRequestEvent());
        expect(yield* Ref.get(withoutFeedback.dispatchedRef)).toEqual([
          {
            type: "runtime-request.respond",
            commandId: CommandId.make(
              `server:bot-action-gate:${withoutFeedback.threadId}:${withoutFeedback.requestId}`,
            ),
            threadId: withoutFeedback.threadId,
            requestId: withoutFeedback.requestId,
            decision: "decline",
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "waits for approval_request turn item when runtime-request arrives first (Claude order)",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          requestKind: "command",
          includeApprovalItem: false,
        });

        // First event arrives before the approval_request turn item exists.
        yield* h.reactor.handle(yield* h.runtimeRequestEvent());
        expect(yield* Ref.get(h.dispatchedRef)).toEqual([]);

        // Approval turn item arrives next.
        yield* Ref.set(h.approvalItemRef, {
          id: TurnItemId.make("item:approval"),
          threadId: h.threadId,
          runId: RUN_ID,
          nodeId: APPROVAL_NODE_ID,
          providerThreadId: PROVIDER_THREAD_ID,
          providerTurnId: PROVIDER_TURN_ID,
          nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
          parentItemId: null,
          ordinal: 2,
          status: "waiting",
          title: null,
          startedAt: NOW,
          completedAt: null,
          updatedAt: NOW,
          type: "approval_request",
          requestId: h.requestId,
          requestKind: "command",
          prompt: "ls -la",
        });
        yield* h.reactor.handle(yield* h.turnItemEvent());

        expect(yield* Ref.get(h.dispatchedRef)).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("leaves user_input, ordinary threads, and botsEnabled=false untouched", () =>
    Effect.gen(function* () {
      const userInput = yield* makeHarness({ requestKind: "user_input" });
      yield* userInput.reactor.handle(yield* userInput.runtimeRequestEvent());
      expect(yield* Ref.get(userInput.dispatchedRef)).toEqual([]);
      expect(yield* Ref.get(userInput.writtenEventsRef)).toEqual([]);

      const ordinary = yield* makeHarness({
        threadId: ORDINARY_THREAD,
        projectId: ORDINARY_PROJECT,
        prompt: "ls -la",
      });
      yield* ordinary.reactor.handle(yield* ordinary.runtimeRequestEvent());
      expect(yield* Ref.get(ordinary.dispatchedRef)).toEqual([]);
      expect(yield* Ref.get(ordinary.writtenEventsRef)).toEqual([]);

      const disabled = yield* makeHarness({
        botsEnabled: false,
        prompt: "ls -la",
      });
      yield* disabled.reactor.handle(yield* disabled.runtimeRequestEvent());
      expect(yield* Ref.get(disabled.dispatchedRef)).toEqual([]);
      expect(yield* Ref.get(disabled.writtenEventsRef)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("holds web_search sibling WebFetch requests as send approvals", () =>
    Effect.gen(function* () {
      const webFetchItem: OrchestrationV2TurnItem = {
        id: TurnItemId.make("item:webfetch-1"),
        threadId: BOT_THREAD,
        runId: RUN_ID,
        nodeId: PARENT_NODE_ID,
        providerThreadId: PROVIDER_THREAD_ID,
        providerTurnId: PROVIDER_TURN_ID,
        nativeItemRef: { driver: CLAUDE_DRIVER, nativeId: "native-1", strength: "strong" },
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "WebFetch",
        startedAt: NOW,
        completedAt: null,
        updatedAt: NOW,
        type: "web_search",
      };
      const h = yield* makeHarness({
        requestKind: "command",
        prompt: "WebFetch: https://example.com/api",
        siblingItems: [webFetchItem],
      });

      yield* h.reactor.handle(yield* h.runtimeRequestEvent());

      expect(yield* Ref.get(h.dispatchedRef)).toEqual([]);
      const updated = yield* Ref.get(h.approvalItemRef);
      expect(updated?.type).toBe("approval_request");
      if (updated?.type === "approval_request") {
        expect(updated.reason).toBe("Bots ask before sending");
        expect(updated.options).toEqual(BOT_HELD_APPROVAL_OPTIONS);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("still holds delete and blocks pay when a bot uses provider approvals mode", () =>
    Effect.gen(function* () {
      const del = yield* makeHarness({
        botApprovals: "provider",
        requestKind: "command",
        prompt: "rm -f notes.txt",
      });
      yield* del.reactor.handle(yield* del.runtimeRequestEvent());
      expect(yield* Ref.get(del.dispatchedRef)).toEqual([]);
      const updated = yield* Ref.get(del.approvalItemRef);
      expect(updated?.type).toBe("approval_request");
      if (updated?.type === "approval_request") {
        expect(updated.reason).toBe("Bots ask before deleting");
        expect(updated.options).toEqual(BOT_HELD_APPROVAL_OPTIONS);
      }

      const pay = yield* makeHarness({
        botApprovals: "provider",
        requestKind: "command",
        supportsFeedback: true,
        prompt: "stripe charges create --amount=500",
      });
      yield* pay.reactor.handle(yield* pay.runtimeRequestEvent());
      expect(yield* Ref.get(pay.dispatchedRef)).toEqual([
        {
          type: "runtime-request.respond",
          commandId: CommandId.make(`server:bot-action-gate:${pay.threadId}:${pay.requestId}`),
          threadId: pay.threadId,
          requestId: pay.requestId,
          decision: "decline",
          feedback: BOT_PAY_BLOCKED_FEEDBACK,
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
