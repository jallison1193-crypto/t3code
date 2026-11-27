import {
  BotApprovalsMode,
  BotDailyUsage,
  BotLimits,
  BotPaymentsMode,
  IsoDateTime,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const BotSummary = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  goal: Schema.String,
  modelSelection: Schema.NullOr(ModelSelection),
  paused: Schema.Boolean,
  limits: Schema.optionalKey(BotLimits),
  approvals: Schema.optionalKey(BotApprovalsMode),
  payments: Schema.optionalKey(BotPaymentsMode),
});

const BotTriggerSummary = Schema.Struct({
  id: ScheduledTaskId,
  title: Schema.String,
  enabled: Schema.Boolean,
  scheduleType: Schema.Literals(["interval", "fixed_time", "once", "webhook"]),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastRunStatus: Schema.Literals(["never", "running", "succeeded", "failed"]),
  blockedByPolicy: Schema.optionalKey(Schema.String),
});

const BotRunSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const BotDetail = Schema.Struct({
  ...BotSummary.fields,
  todayUsage: BotDailyUsage,
  triggers: Schema.Array(BotTriggerSummary),
  recentRuns: Schema.Array(BotRunSummary),
});

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    BotService.BotService,
    ScheduledTaskService.ScheduledTaskService,
  ],
};

const BotReadTool = Tool.make("t3_bot_read", {
  ...shared,
  description:
    "List this server's bots, or pass botId to read one bot's goal, model, paused state, limits, today's usage, triggers, and recent runs.",
  parameters: Schema.Struct({
    botId: Schema.optional(ProjectId),
  }),
  success: Schema.Union([
    Schema.Struct({
      bots: Schema.Array(BotSummary),
    }),
    Schema.Struct({
      bot: BotDetail,
    }),
  ]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotUpdateTool = Tool.make("t3_bot_update", {
  ...shared,
  description:
    "Create, update, pause, or resume a bot, or set its daily limits, approvals, or payments mode. Omit modelSelection to keep or inherit the default model; pass null to clear it.",
  parameters: Schema.Struct({
    action: Schema.Literals(["create", "update", "pause", "resume"]),
    botId: Schema.optional(ProjectId),
    name: Schema.optional(TrimmedNonEmptyString),
    goal: Schema.optional(TrimmedString),
    modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    limits: Schema.optional(BotLimits),
    approvals: Schema.optional(BotApprovalsMode),
    payments: Schema.optional(
      BotPaymentsMode.annotate({
        description:
          "blocked (default) declines payments automatically; ask holds each payment for Approve once.",
      }),
    ),
  }),
  success: Schema.Struct({
    bot: BotSummary,
  }),
}).annotate(Tool.Destructive, false);

export const BotToolkit = Toolkit.make(BotReadTool, BotUpdateTool);
