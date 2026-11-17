import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectMemoryStore from "../../../projectMemory/ProjectMemoryStore.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectMemoryToolkit } from "./tools.ts";

const resolveVerifiedProjectId = Effect.fn("ProjectMemoryToolkit.resolveVerifiedProjectId")(
  function* (requestedProjectId: ProjectId | undefined) {
    const caller = yield* loadCaller();
    const projectId = yield* resolveProjectId(caller, requestedProjectId);
    const projectService = yield* ProjectService.ProjectService;
    const project = yield* projectService.getById(projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project)) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The project was not found.",
      });
    }
    return projectId;
  },
);

const mapStoreError = (error: ProjectMemoryStore.ProjectMemoryError): OrchestratorMcpFailure => {
  switch (error._tag) {
    case "ProjectMemoryValidationError":
    case "ProjectMemoryLimitError":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    case "ProjectMemoryNotFoundError":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    case "ProjectMemoryStorageError":
      return unavailable();
  }
};

export const layer = McpToolAccess.toLayer(ProjectMemoryToolkit, {
  t3_project_memory_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      return yield* store.readMemory(projectId).pipe(Effect.mapError(mapStoreError));
    }),
  ),
  t3_project_memory_write: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      switch (input.mode) {
        case "replace":
          return yield* store
            .writeMemory(projectId, input.content)
            .pipe(Effect.mapError(mapStoreError));
        case "append":
          return yield* store
            .appendMemory(projectId, input.content)
            .pipe(Effect.mapError(mapStoreError));
        case "replace_section": {
          if (input.heading === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "heading is required when mode is 'replace_section'.",
            });
          }
          return yield* store
            .replaceMemorySection(projectId, input.heading, input.content)
            .pipe(Effect.mapError(mapStoreError));
        }
      }
    }),
  ),
  t3_project_knowledge_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      const files = yield* store.listKnowledge(projectId).pipe(Effect.mapError(mapStoreError));
      return { projectId, files };
    }),
  ),
  t3_project_knowledge_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      const matches = yield* store
        .searchKnowledge(projectId, input.query, input.limit)
        .pipe(Effect.mapError(mapStoreError));
      return { projectId, matches };
    }),
  ),
  t3_project_knowledge_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      return yield* store
        .readKnowledge(projectId, input.name, {
          startLine: input.startLine,
          endLine: input.endLine,
        })
        .pipe(Effect.mapError(mapStoreError));
    }),
  ),
  t3_project_knowledge_add: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      return yield* store
        .addKnowledge(projectId, input.name, input.content)
        .pipe(Effect.mapError(mapStoreError));
    }),
  ),
  t3_project_knowledge_delete: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* resolveVerifiedProjectId(input.projectId);
      const store = yield* ProjectMemoryStore.ProjectMemoryStore;
      return yield* store
        .deleteKnowledge(projectId, input.name)
        .pipe(Effect.mapError(mapStoreError));
    }),
  ),
});
