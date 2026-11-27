import {
  type BotCreateInput,
  type BotDeleteResult,
  type BotLimits,
  BotOperationError,
  type BotProfile,
  type BotRecord,
  type BotRunInput,
  type BotRunResult,
  type BotUpdateInput,
  type BotUsageResult,
  CommandId,
  type ModelSelection,
  ProjectId,
  type Project,
  type ProjectSettingsOverrides,
  type ServerSettings,
  isBotPaused,
  isBotProject,
  resolveBotApprovalsMode,
  resolveBotGateCapability,
  resolveBotLimits,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  localDayStartUtc,
  makeBotGateResolver,
  queryBotDailyUsage,
  resolveBotTriggerBlock,
} from "./botUsage.ts";

const SINGLE_LINE_BOT_NAME = /^[^\r\n\v\f\u0085\u2028\u2029]+$/u;
const MAX_BOT_NAME_LENGTH = 120;

const DEFAULT_BOT_ICON = {
  kind: "lucide" as const,
  name: "bot",
  color: "indigo" as const,
};

function validateBotName(
  operation: "create" | "update",
  rawName: string,
  projectId?: ProjectId,
): Effect.Effect<string, BotOperationError> {
  const name = rawName.trim();
  if (name.length === 0 || name.length > MAX_BOT_NAME_LENGTH || !SINGLE_LINE_BOT_NAME.test(name)) {
    return Effect.fail(
      new BotOperationError({
        operation,
        reason: "invalid_name",
        ...(projectId === undefined ? {} : { projectId }),
      }),
    );
  }
  return Effect.succeed(name);
}

function normalizeBotLimits(limits: BotLimits): BotLimits {
  const resolved = resolveBotLimits({ limits });
  if (resolved.mode === "none") return { mode: "none" };
  if (resolved.mode === "runs_only") {
    return { mode: "runs_only", runsPerDay: resolved.runsPerDay };
  }
  return {
    mode: "runs_and_tokens",
    runsPerDay: resolved.runsPerDay,
    tokensPerDay: resolved.tokensPerDay,
  };
}

function toBotRecord(project: Project, settings: ServerSettings): BotRecord {
  const overrides = settings.projectSettingsOverrides[project.id];
  const resolvedLimits = resolveBotLimits(overrides?.bot);
  return {
    projectId: project.id,
    name: project.title,
    goal: overrides?.projectInstructions ?? "",
    modelSelection: overrides?.defaultModelSelection ?? null,
    paused: isBotPaused(settings, project.id),
    limits: {
      mode: resolvedLimits.mode,
      runsPerDay: resolvedLimits.runsPerDay,
      tokensPerDay: resolvedLimits.tokensPerDay,
    },
    approvals: resolveBotApprovalsMode(overrides?.bot),
    workspaceRoot: project.workspaceRoot,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<BotRecord>, BotOperationError>;
    readonly get: (projectId: ProjectId) => Effect.Effect<BotRecord, BotOperationError>;
    readonly getUsage: (projectId: ProjectId) => Effect.Effect<BotUsageResult, BotOperationError>;
    readonly create: (input: BotCreateInput) => Effect.Effect<BotRecord, BotOperationError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<BotRecord, BotOperationError>;
    readonly delete: (projectId: ProjectId) => Effect.Effect<BotDeleteResult, BotOperationError>;
    readonly triggerBlock: (projectId: ProjectId) => Effect.Effect<string | undefined>;
    /** Starts a run by hand. Refused for every reason a trigger is, daily limits included. */
    readonly run: (input: BotRunInput) => Effect.Effect<BotRunResult, BotOperationError>;
  }
>()("t3/bots/BotService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const providerInstancesOption = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );
  const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

  const resolveBotGate = makeBotGateResolver(providerInstancesOption);

  const readSettings = (
    operation: "list" | "get" | "getUsage" | "create" | "update" | "delete" | "run",
    projectId?: ProjectId,
  ) =>
    serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new BotOperationError({
            operation,
            reason: "settings_failed",
            ...(projectId === undefined ? {} : { projectId }),
            cause,
          }),
      ),
    );

  const requireBotsEnabled = (
    operation: "create" | "update" | "delete",
    settings: ServerSettings,
    projectId?: ProjectId,
  ) =>
    settings.botsEnabled
      ? Effect.void
      : Effect.fail(
          new BotOperationError({
            operation,
            reason: "bots_disabled",
            ...(projectId === undefined ? {} : { projectId }),
          }),
        );

  const loadBotProject = Effect.fn("BotService.loadBotProject")(function* (
    operation: "get" | "getUsage" | "update" | "delete" | "run",
    projectId: ProjectId,
    settings: ServerSettings,
  ) {
    const existing = yield* projects.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new BotOperationError({
            operation,
            reason: "project_failed",
            projectId,
            cause,
          }),
      ),
    );
    if (Option.isNone(existing) || existing.value.deletedAt !== null) {
      return yield* new BotOperationError({
        operation,
        reason: "not_found",
        projectId,
      });
    }
    if (!isBotProject(settings, projectId)) {
      return yield* new BotOperationError({
        operation,
        reason: "not_a_bot",
        projectId,
      });
    }
    return existing.value;
  });

  const list: BotService["Service"]["list"] = Effect.fn("BotService.list")(function* () {
    const settings = yield* readSettings("list");
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(
        (cause) =>
          new BotOperationError({
            operation: "list",
            reason: "project_failed",
            cause,
          }),
      ),
    );
    return snapshot.projects
      .filter((project) => project.deletedAt === null && isBotProject(settings, project.id))
      .map((project) => toBotRecord(project, settings));
  });

  const get: BotService["Service"]["get"] = Effect.fn("BotService.get")(function* (projectId) {
    const settings = yield* readSettings("get", projectId);
    const project = yield* loadBotProject("get", projectId, settings);
    return toBotRecord(project, settings);
  });

  const resolveBlock = Effect.fn("BotService.resolveBlock")(function* (
    projectId: ProjectId,
    settings: ServerSettings | undefined,
    modelSelection?: ModelSelection,
  ) {
    const now = yield* localNow;
    return yield* resolveBotTriggerBlock({
      settings,
      projectId,
      modelSelection,
      sql: Option.getOrUndefined(sqlOption),
      now,
      resolveBotGate,
    });
  });

  const triggerBlock: BotService["Service"]["triggerBlock"] = Effect.fn("BotService.triggerBlock")(
    function* (projectId) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return (yield* resolveBlock(projectId, settings))?.reason;
    },
  );

  const getUsage: BotService["Service"]["getUsage"] = Effect.fn("BotService.getUsage")(
    function* (projectId) {
      const settings = yield* readSettings("getUsage", projectId);
      yield* loadBotProject("getUsage", projectId, settings);
      const now = yield* localNow;
      const resolvedLimits = resolveBotLimits(settings.projectSettingsOverrides[projectId]?.bot);
      const usage = Option.isSome(sqlOption)
        ? yield* queryBotDailyUsage(sqlOption.value, projectId, now)
        : {
            runs: 0,
            tokens: 0,
            dayStartAt: DateTime.formatIso(localDayStartUtc(now)),
          };
      const block = yield* resolveBlock(projectId, settings);
      return {
        projectId,
        limits: {
          mode: resolvedLimits.mode,
          runsPerDay: resolvedLimits.runsPerDay,
          tokensPerDay: resolvedLimits.tokensPerDay,
        },
        usage,
        ...(block === undefined
          ? {}
          : {
              blockedByPolicy: block.reason,
              ...(block.reasonCode === undefined ? {} : { blockedReasonCode: block.reasonCode }),
            }),
      };
    },
  );

  const create: BotService["Service"]["create"] = Effect.fn("BotService.create")(function* (input) {
    const settings = yield* readSettings("create");
    yield* requireBotsEnabled("create", settings);
    const name = yield* validateBotName("create", input.name);
    const goal = (input.goal ?? "").trim();

    const { workspaceRoot } = yield* managedFolders.createBotFolder({ name }).pipe(
      Effect.mapError(
        (cause) =>
          new BotOperationError({
            operation: "create",
            reason: "folder_failed",
            cause,
          }),
      ),
    );
    const removeFolder = fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore);
    const id = yield* random.uuidV4().pipe(
      Effect.tapError(() => removeFolder),
      Effect.mapError(
        (cause) =>
          new BotOperationError({
            operation: "create",
            reason: "project_failed",
            cause,
          }),
      ),
    );
    const projectId = ProjectId.make(id);
    const createdProject = yield* projects
      .create({
        commandId: CommandId.make(`bot-create:${id}`),
        projectId,
        title: name,
        workspaceRoot,
      })
      .pipe(
        Effect.tapError(() => removeFolder),
        Effect.mapError(
          (cause) =>
            new BotOperationError({
              operation: "create",
              reason: "project_failed",
              projectId,
              cause,
            }),
        ),
      );

    const rollbackProject = projects
      .delete({
        commandId: CommandId.make(`bot-create-rollback:${id}`),
        projectId: createdProject.id,
        force: true,
      })
      .pipe(Effect.ignore, Effect.andThen(removeFolder));

    const project = yield* projects
      .update({
        commandId: CommandId.make(`bot-icon:${id}`),
        projectId: createdProject.id,
        projectIcon: DEFAULT_BOT_ICON,
      })
      .pipe(Effect.orElseSucceed(() => createdProject));

    const effectiveLimits = input.limits ?? settings.botDefaults?.limits;
    const effectiveApprovals = input.approvals ?? "t3_gate";
    const botProfile: BotProfile = {
      ...(effectiveLimits === undefined ? {} : { limits: normalizeBotLimits(effectiveLimits) }),
      ...(effectiveApprovals === "provider" ? { approvals: "provider" } : {}),
    };

    let effectiveModelSelection: ModelSelection | null = null;
    if (input.modelSelection !== undefined) {
      effectiveModelSelection = input.modelSelection;
    } else if (settings.botDefaults?.modelSelection !== undefined) {
      const defaultModel = settings.botDefaults.modelSelection;
      const capability =
        resolveBotGate !== undefined
          ? yield* resolveBotGate(defaultModel.instanceId)
          : resolveBotGateCapability({
              driver:
                settings.providerInstances[defaultModel.instanceId]?.driver ??
                defaultModel.instanceId,
            });
      if (
        capability?.status === "supported" ||
        (effectiveApprovals === "provider" &&
          (capability === undefined ||
            capability.status !== "unsupported" ||
            capability.reasonCode !== "provider_unavailable"))
      ) {
        effectiveModelSelection = defaultModel;
      }
    }

    const override: ProjectSettingsOverrides = {
      bot: botProfile,
      ...(goal.length > 0 ? { projectInstructions: goal } : {}),
      ...(effectiveModelSelection !== null
        ? { defaultModelSelection: effectiveModelSelection }
        : {}),
    };

    const nextSettings = yield* serverSettings
      .updateSettings({
        projectSettingsOverrides: {
          [project.id]: override,
        },
      })
      .pipe(
        Effect.tapError(() => rollbackProject),
        Effect.mapError(
          (cause) =>
            new BotOperationError({
              operation: "create",
              reason: "settings_failed",
              projectId: project.id,
              cause,
            }),
        ),
      );

    return toBotRecord(project, nextSettings);
  });

  const update: BotService["Service"]["update"] = Effect.fn("BotService.update")(function* (input) {
    const settings = yield* readSettings("update", input.projectId);
    yield* requireBotsEnabled("update", settings, input.projectId);
    let project = yield* loadBotProject("update", input.projectId, settings);

    if (input.name !== undefined) {
      const name = yield* validateBotName("update", input.name, input.projectId);
      if (name !== project.title) {
        const commandUuid = yield* random.uuidV4().pipe(
          Effect.mapError(
            (cause) =>
              new BotOperationError({
                operation: "update",
                reason: "project_failed",
                projectId: input.projectId,
                cause,
              }),
          ),
        );
        project = yield* projects
          .update({
            commandId: CommandId.make(`bot-update:${commandUuid}`),
            projectId: input.projectId,
            title: name,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new BotOperationError({
                  operation: "update",
                  reason: "project_failed",
                  projectId: input.projectId,
                  cause,
                }),
            ),
          );
      }
    }

    let nextSettings = settings;
    if (
      input.goal !== undefined ||
      input.modelSelection !== undefined ||
      input.paused !== undefined ||
      input.limits !== undefined ||
      input.approvals !== undefined
    ) {
      const latest = yield* readSettings("update", input.projectId);
      const currentOverride = latest.projectSettingsOverrides[input.projectId] ?? { bot: {} };
      const {
        projectInstructions: currentGoal,
        defaultModelSelection: currentModel,
        bot: currentBot,
        ...restOverrides
      } = currentOverride;

      const nextGoal = input.goal === undefined ? currentGoal : input.goal.trim();
      const nextModel = input.modelSelection === undefined ? currentModel : input.modelSelection;
      const nextPaused = input.paused === undefined ? currentBot?.paused : input.paused;
      const nextLimits =
        input.limits === undefined ? currentBot?.limits : normalizeBotLimits(input.limits);
      const nextApprovals = input.approvals === undefined ? currentBot?.approvals : input.approvals;
      const nextBot: BotProfile = {
        ...(nextPaused === true ? { paused: true } : {}),
        ...(nextLimits === undefined ? {} : { limits: nextLimits }),
        ...(nextApprovals === "provider" ? { approvals: "provider" } : {}),
      };

      const nextOverride: ProjectSettingsOverrides = {
        ...restOverrides,
        bot: nextBot,
        ...(nextGoal !== undefined && nextGoal.length > 0 ? { projectInstructions: nextGoal } : {}),
        ...(nextModel !== undefined && nextModel !== null
          ? { defaultModelSelection: nextModel }
          : {}),
      };

      nextSettings = yield* serverSettings
        .updateSettings({
          projectSettingsOverrides: {
            [input.projectId]: nextOverride,
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new BotOperationError({
                operation: "update",
                reason: "settings_failed",
                projectId: input.projectId,
                cause,
              }),
          ),
        );

      if (input.modelSelection !== undefined) {
        const syncedModelSelection = nextModel ?? nextSettings.defaultModelSelection;
        if (syncedModelSelection !== null) {
          const listedTasks = yield* scheduledTasks.list().pipe(
            Effect.mapError(
              (cause) =>
                new BotOperationError({
                  operation: "update",
                  reason: "scheduled_tasks_failed",
                  projectId: input.projectId,
                  detail: "Could not update the bot's triggers with the new model.",
                  cause,
                }),
            ),
          );
          const botTasks = listedTasks.tasks.filter(
            (task) =>
              task.projectId === input.projectId &&
              !Equal.equals(task.modelSelection, syncedModelSelection),
          );
          for (const task of botTasks) {
            yield* scheduledTasks
              .upsert({
                id: task.id,
                requireExisting: true,
                title: task.title,
                prompt: task.prompt,
                enabled: task.enabled,
                schedule: task.schedule,
                projectId: task.projectId,
                threadId: task.threadId,
                ...(task.threadMode === undefined ? {} : { threadMode: task.threadMode }),
                workspaceStrategy: task.workspaceStrategy,
                modelSelection: syncedModelSelection,
                runtimeMode: task.runtimeMode,
                interactionMode: task.interactionMode,
                createdBy: task.createdBy,
                creationSource: task.creationSource,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new BotOperationError({
                      operation: "update",
                      reason: "scheduled_tasks_failed",
                      projectId: input.projectId,
                      detail: "Could not update the bot's triggers with the new model.",
                      cause,
                    }),
                ),
              );
          }
        }
      }
    }

    return toBotRecord(project, nextSettings);
  });

  const deleteBot: BotService["Service"]["delete"] = Effect.fn("BotService.delete")(
    function* (projectId) {
      const settings = yield* readSettings("delete", projectId);
      yield* requireBotsEnabled("delete", settings, projectId);
      yield* loadBotProject("delete", projectId, settings);

      const listedTasks = yield* scheduledTasks.list().pipe(
        Effect.mapError(
          (cause) =>
            new BotOperationError({
              operation: "delete",
              reason: "scheduled_tasks_failed",
              projectId,
              cause,
            }),
        ),
      );
      const botTasks = listedTasks.tasks.filter((task) => task.projectId === projectId);
      const deletedScheduledTaskIds: string[] = [];
      for (const task of botTasks) {
        yield* scheduledTasks.delete({ id: task.id }).pipe(
          Effect.mapError(
            (cause) =>
              new BotOperationError({
                operation: "delete",
                reason: "scheduled_tasks_failed",
                projectId,
                cause,
              }),
          ),
        );
        deletedScheduledTaskIds.push(task.id);
      }

      const commandUuid = yield* random.uuidV4().pipe(
        Effect.mapError(
          (cause) =>
            new BotOperationError({
              operation: "delete",
              reason: "project_failed",
              projectId,
              cause,
            }),
        ),
      );
      yield* projects
        .delete({
          commandId: CommandId.make(`bot-delete:${commandUuid}`),
          projectId,
          force: true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new BotOperationError({
                operation: "delete",
                reason: "project_failed",
                projectId,
                cause,
              }),
          ),
        );

      return {
        projectId,
        deletedScheduledTaskIds,
      };
    },
  );

  const run: BotService["Service"]["run"] = Effect.fn("BotService.run")(function* (input) {
    const { projectId } = input;
    const settings = yield* readSettings("run", projectId);
    const project = yield* loadBotProject("run", projectId, settings);
    const modelSelection =
      settings.projectSettingsOverrides[projectId]?.defaultModelSelection ??
      settings.defaultModelSelection ??
      input.fallbackModelSelection;
    const blockedReason = (yield* resolveBlock(projectId, settings, modelSelection))?.reason;
    if (blockedReason !== undefined) {
      return yield* new BotOperationError({
        operation: "run",
        reason: "blocked",
        projectId,
        detail: blockedReason,
      });
    }
    if (modelSelection === undefined) {
      return yield* new BotOperationError({ operation: "run", reason: "no_model", projectId });
    }

    const runFailed = (cause: unknown) =>
      new BotOperationError({ operation: "run", reason: "run_failed", projectId, cause });
    const commandUuid = yield* random.uuidV4().pipe(Effect.mapError(runFailed));
    const launched = yield* threadLaunch
      .launch({
        commandId: CommandId.make(`bot-run:${commandUuid}`),
        projectId,
        title: project.title,
        modelSelection,
        // The bot gate holds every bot thread here; storing it also fits any managed ceiling.
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: input.prompt, attachments: [] },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(runFailed));
    return { projectId, threadId: launched.threadId };
  });

  return BotService.of({
    list,
    get,
    getUsage,
    create,
    update,
    delete: deleteBot,
    triggerBlock,
    run,
  });
});

export const layer = Layer.effect(BotService, make);
