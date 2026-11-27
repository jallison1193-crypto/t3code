import {
  CommandId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type RuntimeRequestId,
  type ThreadId,
  isBotProject,
  resolveBotPaymentsMode,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  BOT_HELD_APPROVAL_OPTIONS,
  BOT_PAY_BLOCKED_FEEDBACK,
  type BotActionRequest,
  botHeldApprovalReason,
  classifyBotAction,
} from "./botActionPolicy.ts";
import { formatBotPaymentHeldReason } from "./botPaymentDetails.ts";

type ApprovalTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }>;

function isAlreadyHeld(item: ApprovalTurnItem, expectedReason: string): boolean {
  if (item.reason !== expectedReason) return false;
  if (item.fullAccessOverride !== undefined) return false;
  if (item.options === undefined || item.options.length !== BOT_HELD_APPROVAL_OPTIONS.length) {
    return false;
  }
  return item.options.every(
    (option, index) =>
      option.decision === BOT_HELD_APPROVAL_OPTIONS[index]?.decision &&
      option.label === BOT_HELD_APPROVAL_OPTIONS[index]?.label,
  );
}

function extractSiblingActionDetails(input: {
  readonly approvalItem: ApprovalTurnItem;
  readonly parentNodeId: string | null | undefined;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): Pick<BotActionRequest, "toolName" | "command" | "fileChanges"> & {
  readonly toolInput?: unknown;
} {
  const nativeId = input.approvalItem.nativeItemRef?.nativeId;
  const siblings = input.turnItems.filter((candidate) => {
    if (candidate.id === input.approvalItem.id) return false;
    if (input.parentNodeId != null && candidate.nodeId === input.parentNodeId) return true;
    return nativeId !== undefined && candidate.nativeItemRef?.nativeId === nativeId;
  });

  let toolName: string | undefined;
  let toolInput: unknown;
  let command: string | undefined;
  let fileChanges: BotActionRequest["fileChanges"];

  for (const sibling of siblings) {
    if (sibling.type === "dynamic_tool" && sibling.toolName !== null) {
      toolName = sibling.toolName;
      toolInput = sibling.input;
    } else if (sibling.type === "web_search" && sibling.title !== null) {
      toolName ??= sibling.title;
    } else if (sibling.type === "command_execution" && sibling.input.trim().length > 0) {
      command = sibling.input;
    } else if (sibling.type === "file_change" && sibling.changes !== undefined) {
      fileChanges = sibling.changes;
    }
  }

  return { toolName, toolInput, command, fileChanges };
}

function isApprovalRuntimeRequestKind(kind: string): boolean {
  return (
    kind === "command" ||
    kind === "file-read" ||
    kind === "file-change" ||
    kind === "mcp-elicitation" ||
    kind === "permission"
  );
}

function requestIdFromEvent(event: OrchestrationV2DomainEvent): RuntimeRequestId | null {
  if (event.type === "runtime-request.updated") {
    if (!isApprovalRuntimeRequestKind(event.payload.kind) || event.payload.status !== "pending") {
      return null;
    }
    return event.payload.id;
  }
  if (event.type === "turn-item.updated") {
    if (event.payload.type !== "approval_request" || event.payload.status !== "waiting") {
      return null;
    }
    return event.payload.requestId;
  }
  return null;
}

export class BotActionGateReactor extends Context.Service<
  BotActionGateReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/bots/BotActionGateReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;

  const handle: BotActionGateReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      const requestId = requestIdFromEvent(event);
      if (requestId === null) return;

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!settings?.botsEnabled) return;

      const thread = yield* projections.getThread(event.threadId);
      if (!isBotProject(settings, thread.projectId)) return;

      const context = yield* projections.getRuntimeResponseContext(event.threadId, requestId);
      const request = context.request;
      const item = context.item;
      if (
        request === undefined ||
        request.status !== "pending" ||
        !isApprovalRuntimeRequestKind(request.kind)
      ) {
        return;
      }
      // Wait for the matching approval_request turn item (Claude emits runtime-request before turn-item).
      if (item === undefined || item.type !== "approval_request") {
        return;
      }

      const { turnItems } = yield* projections.getThreadRecords(event.threadId, ["turnItems"]);
      const sibling = extractSiblingActionDetails({
        approvalItem: item,
        parentNodeId: context.node?.parentNodeId,
        turnItems,
      });

      const classification = classifyBotAction({
        kind: item.requestKind,
        toolName: sibling.toolName,
        command: sibling.command,
        prompt: item.prompt,
        appName: item.appName,
        fileChanges: sibling.fileChanges,
      });

      const commandId = CommandId.make(`server:bot-action-gate:${event.threadId}:${request.id}`);

      if (classification.decision === "allow") {
        yield* engine.dispatch({
          type: "runtime-request.respond",
          commandId,
          threadId: event.threadId,
          requestId: request.id,
          decision: "accept",
        });
        return;
      }

      const paymentsMode = resolveBotPaymentsMode(
        settings.projectSettingsOverrides[thread.projectId]?.bot,
      );
      const holdAsPayment =
        classification.decision === "block" &&
        classification.category === "pay" &&
        paymentsMode === "ask";

      if (classification.decision === "block" && !holdAsPayment) {
        const supportsFeedback =
          request.responseCapability.type === "live" &&
          request.responseCapability.supportsFeedback === true;
        yield* engine.dispatch({
          type: "runtime-request.respond",
          commandId,
          threadId: event.threadId,
          requestId: request.id,
          decision: "decline",
          ...(supportsFeedback ? { feedback: BOT_PAY_BLOCKED_FEEDBACK } : {}),
        });
        return;
      }

      // `ask` (and `pay` under payments=ask): leave pending for the user, label why it was held, and restrict to Approve once / Decline.
      const reason = holdAsPayment
        ? formatBotPaymentHeldReason({
            command: sibling.command,
            prompt: item.prompt,
            toolName: sibling.toolName,
            toolInput: sibling.toolInput,
          })
        : botHeldApprovalReason(classification.category);
      if (isAlreadyHeld(item, reason)) return;

      const now = yield* DateTime.now;
      const eventId = EventId.make(yield* random.uuidV4());
      const { fullAccessOverride: _stripped, ...restItem } = item;
      const updatedItem: ApprovalTurnItem = {
        ...restItem,
        reason,
        options: [...BOT_HELD_APPROVAL_OPTIONS],
        updatedAt: now,
      };
      yield* eventSink.write({
        events: [
          {
            id: eventId,
            type: "turn-item.updated",
            threadId: event.threadId,
            ...(item.runId === null ? {} : { runId: item.runId }),
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            occurredAt: now,
            payload: updatedItem,
          },
        ],
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("bot action gate reaction failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause,
          }),
        ),
      ),
  );

  const start: BotActionGateReactor["Service"]["start"] = Effect.fn("BotActionGateReactor.start")(
    function* () {
      const threadReactions = yield* KeyedLock.makeRunner<ThreadId>();
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          requestIdFromEvent(event) === null
            ? Effect.void
            : threadReactions.run(event.threadId, handle(event)),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("bot action gate event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return { start, handle } satisfies BotActionGateReactor["Service"];
});

export const layer = Layer.effect(BotActionGateReactor, make);
