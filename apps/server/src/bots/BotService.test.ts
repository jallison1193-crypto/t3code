import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  BOT_PAUSED_REASON,
  BOTS_DISABLED_REASON,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type Project,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotService from "./BotService.ts";

const EPOCH_ISO = "2026-10-01T12:00:00.000Z";

const makeScheduledTask = (id: string, projectId: ProjectId): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: `Task ${id}`,
  prompt: "Check status",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: EPOCH_ISO,
  updatedAt: EPOCH_ISO,
  nextRunAt: EPOCH_ISO,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

const makeHarness = Effect.fn("BotServiceTest.makeHarness")(function* (initial?: {
  readonly botsEnabled?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-service-test-" });
  const projectsMap = new Map<ProjectId, Project>();
  const tasksMap = new Map<ScheduledTaskId, ScheduledTask>();
  const deletedProjectIds: ProjectId[] = [];
  const deletedTaskIds: ScheduledTaskId[] = [];

  const ordinaryProjectId = ProjectId.make("project:ordinary");
  projectsMap.set(ordinaryProjectId, {
    id: ordinaryProjectId,
    title: "Ordinary Project",
    workspaceRoot: path.join(tempRoot, "ordinary"),
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    projectIcon: null,
    scripts: [],
    trackedFolders: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: EPOCH_ISO,
    updatedAt: EPOCH_ISO,
    deletedAt: null,
  });

  const serverSettingsLayer = ServerSettings.layerTest({
    botsEnabled: initial?.botsEnabled ?? true,
  });

  const deps = Layer.mergeAll(
    serverSettingsLayer,
    NodeCrypto.layer,
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: path.join(tempRoot, "projects"),
      createBotFolder: ({ name }) =>
        Effect.gen(function* () {
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "bot";
          const dir = path.join(tempRoot, "bots", `${slug}-${projectsMap.size + 1}`);
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
          return { workspaceRoot: dir };
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      snapshot: Effect.sync(() => ({
        projects: [...projectsMap.values()],
        updatedAt: EPOCH_ISO,
      })),
      getById: (projectId) => Effect.sync(() => Option.fromUndefinedOr(projectsMap.get(projectId))),
      create: (input) =>
        Effect.sync(() => {
          const project: Project = {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            projectIcon: null,
            scripts: [],
            trackedFolders: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: EPOCH_ISO,
            updatedAt: EPOCH_ISO,
            deletedAt: null,
          };
          projectsMap.set(project.id, project);
          return project;
        }),
      update: (input) =>
        Effect.sync(() => {
          const current = projectsMap.get(input.projectId)!;
          const next: Project = {
            ...current,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
          };
          projectsMap.set(input.projectId, next);
          return next;
        }),
      delete: (input) =>
        Effect.sync(() => {
          const current = projectsMap.get(input.projectId)!;
          deletedProjectIds.push(input.projectId);
          projectsMap.delete(input.projectId);
          return { ...current, deletedAt: EPOCH_ISO };
        }),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () =>
        Effect.sync(() => ({
          tasks: [...tasksMap.values()],
          timeZone: "UTC",
        })),
      delete: ({ id }) =>
        Effect.sync(() => {
          deletedTaskIds.push(id);
          tasksMap.delete(id);
          return { id };
        }),
    }),
  );

  const layer = BotService.layer.pipe(Layer.provideMerge(deps));
  const ctx = yield* Layer.build(layer);
  const service = yield* BotService.BotService.pipe(Effect.provide(ctx));
  const settings = yield* ServerSettings.ServerSettingsService.pipe(Effect.provide(ctx));

  return {
    service,
    settings,
    ordinaryProjectId,
    projectsMap,
    tasksMap,
    deletedProjectIds,
    deletedTaskIds,
  };
});

describe("BotService", () => {
  it.effect(
    "creates, lists, updates, pauses, checks triggerBlock, and deletes a bot with its tasks",
    () =>
      Effect.gen(function* () {
        const {
          service,
          settings,
          ordinaryProjectId,
          tasksMap,
          deletedProjectIds,
          deletedTaskIds,
        } = yield* makeHarness();

        const model = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        };
        const created = yield* service.create({
          name: "PR Digest",
          goal: "Summarize open pull requests every morning.",
          modelSelection: model,
        });

        expect(created.name).toBe("PR Digest");
        expect(created.goal).toBe("Summarize open pull requests every morning.");
        expect(created.modelSelection).toEqual(model);
        expect(created.paused).toBe(false);

        const savedSettings = yield* settings.getSettings;
        expect(savedSettings.projectSettingsOverrides[created.projectId]).toEqual({
          bot: {},
          projectInstructions: "Summarize open pull requests every morning.",
          defaultModelSelection: model,
        });

        // list includes bots and excludes ordinary projects.
        const listed = yield* service.list();
        expect(listed.map((b) => b.projectId)).toEqual([created.projectId]);
        expect(yield* service.get(created.projectId)).toEqual(created);
        const notABot = yield* service.get(ordinaryProjectId).pipe(Effect.flip);
        expect(notABot.reason).toBe("not_a_bot");

        // Update name, goal, clear model, and pause.
        const updated = yield* service.update({
          projectId: created.projectId,
          name: "Daily PR Digest",
          goal: "Summarize high-priority PRs.",
          modelSelection: null,
          paused: true,
        });
        expect(updated.name).toBe("Daily PR Digest");
        expect(updated.goal).toBe("Summarize high-priority PRs.");
        expect(updated.modelSelection).toBeNull();
        expect(updated.paused).toBe(true);

        expect(yield* service.triggerBlock(created.projectId)).toBe(BOT_PAUSED_REASON);
        expect(yield* service.triggerBlock(ordinaryProjectId)).toBeUndefined();

        // Turning bots off overrides paused reason and blocks mutations.
        yield* settings.updateSettings({ botsEnabled: false });
        expect(yield* service.triggerBlock(created.projectId)).toBe(BOTS_DISABLED_REASON);
        const disabledErr = yield* service.create({ name: "Blocked", goal: "" }).pipe(Effect.flip);
        expect(disabledErr.reason).toBe("bots_disabled");
        expect(disabledErr.message).toBe(BOTS_DISABLED_REASON);

        // Re-enable and unpause.
        yield* settings.updateSettings({ botsEnabled: true });
        const resumed = yield* service.update({ projectId: created.projectId, paused: false });
        expect(resumed.paused).toBe(false);
        expect(yield* service.triggerBlock(created.projectId)).toBeUndefined();

        // Delete removes bot's scheduled tasks and leaves ordinary tasks intact.
        const botTask = makeScheduledTask("task:bot", created.projectId);
        const ordinaryTask = makeScheduledTask("task:ordinary", ordinaryProjectId);
        tasksMap.set(botTask.id, botTask);
        tasksMap.set(ordinaryTask.id, ordinaryTask);

        const deleted = yield* service.delete(created.projectId);
        expect(deleted).toEqual({
          projectId: created.projectId,
          deletedScheduledTaskIds: [botTask.id],
        });
        expect(deletedTaskIds).toEqual([botTask.id]);
        expect(tasksMap.has(ordinaryTask.id)).toBe(true);
        expect(deletedProjectIds).toEqual([created.projectId]);
        expect(yield* service.list()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
