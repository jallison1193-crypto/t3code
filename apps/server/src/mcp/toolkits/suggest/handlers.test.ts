import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  THREAD_SUGGEST_MAX_ITEMS,
  THREAD_SUGGEST_MAX_PROMPT_LENGTH,
  THREAD_SUGGEST_MAX_TITLE_LENGTH,
  threadSuggestionsFromToolItem,
} from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as SuggestHandlers from "./handlers.ts";
import { SuggestToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:suggest");
const threadId = ThreadId.make("thread:suggest");

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:suggest",
  thread: {
    threadId,
    providerSessionId: "provider:suggest",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const clientScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:suggest",
  thread: undefined,
  client: {
    sessionId: "session",
    label: "Test Client",
    access: "full-access",
  },
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "suggest-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "suggest-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerThreadManagement = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
});

const layerSuggestServer = McpHttpServer.toolkitRegistration(
  SuggestToolkit,
  SuggestHandlers.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(layerThreadManagement),
);

const callSuggest = (
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = threadScope,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server.callTool({
      name: "t3_thread_suggest",
      arguments: args,
    });
  }).pipe(
    Effect.provide(layerSuggestServer),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

it.effect("echoes trimmed suggestions", () =>
  Effect.gen(function* () {
    const result = yield* callSuggest({
      suggestions: [
        {
          title: "  Fix flaky reconnect test  ",
          prompt: "  Investigate src/session.test.ts and stabilize reconnect().\nRun tests.  ",
          reason: "  Separate from the main refactor  ",
        },
        {
          title: "Audit CSV timezone handling",
          prompt: "Switch src/export/csv.ts to UTC.",
        },
      ],
    });
    const expected = [
      {
        title: "Fix flaky reconnect test",
        prompt: "Investigate src/session.test.ts and stabilize reconnect().\nRun tests.",
        reason: "Separate from the main refactor",
      },
      {
        title: "Audit CSV timezone handling",
        prompt: "Switch src/export/csv.ts to UTC.",
      },
    ];
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ suggestions: expected });
    expect(
      threadSuggestionsFromToolItem({
        toolName: "mcp__t3-code__t3_thread_suggest",
        output: result.content,
      }),
    ).toEqual(expected);
  }),
);

it.effect("rejects invalid suggestion lists and fields", () =>
  Effect.gen(function* () {
    const valid = { title: "Follow-up", prompt: "Do the follow-up work." };
    const invalidInputs: ReadonlyArray<Record<string, unknown>> = [
      { suggestions: [] },
      {
        suggestions: Array.from({ length: THREAD_SUGGEST_MAX_ITEMS + 1 }, (_, index) => ({
          title: `Task ${index + 1}`,
          prompt: "Do it.",
        })),
      },
      { suggestions: [{ title: "Line 1\nLine 2", prompt: "Do it." }] },
      {
        suggestions: [{ title: "x".repeat(THREAD_SUGGEST_MAX_TITLE_LENGTH + 1), prompt: "Do it." }],
      },
      {
        suggestions: [
          { title: "Too long prompt", prompt: "x".repeat(THREAD_SUGGEST_MAX_PROMPT_LENGTH + 1) },
        ],
      },
      { suggestions: [{ ...valid, reason: "Line 1\nLine 2" }] },
    ];
    for (const input of invalidInputs) {
      const error = yield* Effect.flip(callSuggest(input));
      expect(error, JSON.stringify(input)).toBeInstanceOf(McpSchema.InvalidParams);
    }
  }),
);

it.effect("refuses calls without a calling thread", () =>
  Effect.gen(function* () {
    const serverError = yield* Effect.flip(
      callSuggest(
        { suggestions: [{ title: "Follow-up", prompt: "Do the follow-up work." }] },
        clientScope,
      ),
    );
    expect(serverError).toBeInstanceOf(McpSchema.InvalidParams);

    const handlerResult = yield* Effect.gen(function* () {
      const toolkit = yield* SuggestToolkit;
      return yield* toolkit
        .handle("t3_thread_suggest", {
          suggestions: [{ title: "Follow-up", prompt: "Do the follow-up work." }],
        })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SuggestHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, clientScope),
              layerThreadManagement,
            ),
          ),
        ),
      ),
    );
    expect(handlerResult).toMatchObject({ code: "thread_credential_required" });
  }),
);
