import {
  type BotCreateInput,
  type BotDeleteResult,
  BotOperationError,
  type BotRecord,
  type BotUpdateInput,
  CommandId,
  ProjectId,
  type Project,
  type ProjectSettingsOverrides,
  type ServerSettings,
  botTriggerBlockReason,
  isBotPaused,
  isBotProject,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../serverSettings.ts";

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

function toBotRecord(project: Project, settings: ServerSettings): BotRecord {
  const overrides = settings.projectSettingsOverrides[project.id];
  return {
    projectId: project.id,
    name: project.title,
    goal: overrides?.projectInstructions ?? "",
    modelSelection: overrides?.defaultModelSelection ?? null,
    paused: isBotPaused(settings, project.id),
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
    readonly create: (input: BotCreateInput) => Effect.Effect<BotRecord, BotOperationError>;
    readonly update: (input: BotUpdateInput) => Effect.Effect<BotRecord, BotOperationError>;
    readonly delete: (projectId: ProjectId) => Effect.Effect<BotDeleteResult, BotOperationError>;
    readonly triggerBlock: (projectId: ProjectId) => Effect.Effect<string | undefined>;
  }
>()("t3/bots/BotService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;

  const readSettings = (
    operation: "list" | "get" | "create" | "update" | "delete",
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
    operation: "get" | "update" | "delete",
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

    const override: ProjectSettingsOverrides = {
      bot: {},
      ...(goal.length > 0 ? { projectInstructions: goal } : {}),
      ...(input.modelSelection !== undefined && input.modelSelection !== null
        ? { defaultModelSelection: input.modelSelection }
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
      input.paused !== undefined
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
      const nextBot =
        input.paused === undefined ? (currentBot ?? {}) : input.paused ? { paused: true } : {};

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

  const triggerBlock: BotService["Service"]["triggerBlock"] = Effect.fn("BotService.triggerBlock")(
    function* (projectId) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return botTriggerBlockReason(settings, projectId);
    },
  );

  return BotService.of({
    list,
    get,
    create,
    update,
    delete: deleteBot,
    triggerBlock,
  });
});

export const layer = Layer.effect(BotService, make);
