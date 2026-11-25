import {
  BOTS_DISABLED_REASON,
  type BotOperationError,
  type BotRecord,
  isListedThreadLineage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { BotToolkit } from "./tools.ts";

const MAX_RECENT_RUNS = 10;

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

const toBotSummary = (bot: BotRecord) => ({
  id: bot.projectId,
  name: bot.name,
  goal: bot.goal,
  modelSelection: bot.modelSelection,
  paused: bot.paused,
});

const mapBotError = (error: BotOperationError): OrchestratorMcpFailure => {
  switch (error.reason) {
    case "bots_disabled":
    case "not_found":
    case "not_a_bot":
    case "invalid_name":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    default:
      return unavailable();
  }
};

export const layer = McpToolAccess.toLayer(BotToolkit, {
  t3_bot_read: McpToolAccess.reads(
    Effect.fn("BotToolkit.read")(function* (input) {
      yield* readCaller();
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(unavailable));
      if (!settings.botsEnabled) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: BOTS_DISABLED_REASON,
        });
      }
      const bots = yield* BotService.BotService;
      if (input.botId === undefined) {
        const listed = yield* bots.list().pipe(Effect.mapError(mapBotError));
        return { bots: listed.map(toBotSummary) };
      }

      const bot = yield* bots.get(input.botId).pipe(Effect.mapError(mapBotError));
      const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
      const threads = yield* ThreadManagementService.ThreadManagementService;

      const listedTasks = yield* scheduledTasks.list().pipe(Effect.mapError(unavailable));
      const triggers = listedTasks.tasks
        .filter((task) => task.projectId === bot.projectId)
        .map((task) => ({
          id: task.id,
          title: task.title,
          enabled: task.enabled,
          scheduleType: task.schedule.type,
          nextRunAt: task.nextRunAt,
          lastRunAt: task.lastRunAt,
          lastRunStatus: task.lastRunStatus,
          ...(task.blockedByPolicy === undefined ? {} : { blockedByPolicy: task.blockedByPolicy }),
        }));

      const snapshot = yield* threads
        .getShellSnapshot({ projectId: bot.projectId })
        .pipe(Effect.mapError(unavailable));
      const recentRuns = [...snapshot.threads, ...snapshot.archivedThreads]
        .filter((thread) => thread.deletedAt === null && isListedThreadLineage(thread.lineage))
        .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
        .slice(0, MAX_RECENT_RUNS)
        .map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          status: thread.status,
          createdAt: DateTime.formatIso(thread.createdAt),
          updatedAt: DateTime.formatIso(thread.updatedAt),
        }));

      return {
        bot: {
          ...toBotSummary(bot),
          triggers,
          recentRuns,
        },
      };
    }),
  ),
  t3_bot_update: McpToolAccess.writes(
    Effect.fn("BotToolkit.update")(function* (input) {
      yield* readCaller();
      const bots = yield* BotService.BotService;
      switch (input.action) {
        case "create": {
          const name = yield* required(input.name, "name");
          const bot = yield* bots
            .create({
              name,
              ...(input.goal === undefined ? {} : { goal: input.goal }),
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
            })
            .pipe(Effect.mapError(mapBotError));
          return { bot: toBotSummary(bot) };
        }
        case "update": {
          const botId = yield* required(input.botId, "botId");
          const bot = yield* bots
            .update({
              projectId: botId,
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.goal === undefined ? {} : { goal: input.goal }),
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
            })
            .pipe(Effect.mapError(mapBotError));
          return { bot: toBotSummary(bot) };
        }
        case "pause": {
          const botId = yield* required(input.botId, "botId");
          const bot = yield* bots
            .update({ projectId: botId, paused: true })
            .pipe(Effect.mapError(mapBotError));
          return { bot: toBotSummary(bot) };
        }
        case "resume": {
          const botId = yield* required(input.botId, "botId");
          const bot = yield* bots
            .update({ projectId: botId, paused: false })
            .pipe(Effect.mapError(mapBotError));
          return { bot: toBotSummary(bot) };
        }
      }
    }),
  ),
});
