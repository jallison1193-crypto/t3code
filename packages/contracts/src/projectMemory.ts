import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PROJECT_MEMORY_MAX_BYTES = 64 * 1024;
export const PROJECT_KNOWLEDGE_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_KNOWLEDGE_MAX_FILES = 100;
export const PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH = 200;

export const ProjectKnowledgeFileName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH),
);
export type ProjectKnowledgeFileName = typeof ProjectKnowledgeFileName.Type;

export const ProjectMemoryGetInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectMemoryGetInput = typeof ProjectMemoryGetInput.Type;

export const ProjectMemoryGetResult = Schema.Struct({
  projectId: ProjectId,
  exists: Schema.Boolean,
  content: Schema.String,
  sizeBytes: NonNegativeInt,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectMemoryGetResult = typeof ProjectMemoryGetResult.Type;

export const ProjectMemorySetInput = Schema.Struct({
  projectId: ProjectId,
  content: Schema.String,
});
export type ProjectMemorySetInput = typeof ProjectMemorySetInput.Type;

export const ProjectMemorySetResult = Schema.Struct({
  projectId: ProjectId,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectMemorySetResult = typeof ProjectMemorySetResult.Type;

export const ProjectKnowledgeFileSummary = Schema.Struct({
  name: ProjectKnowledgeFileName,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectKnowledgeFileSummary = typeof ProjectKnowledgeFileSummary.Type;

export const ProjectKnowledgeListInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectKnowledgeListInput = typeof ProjectKnowledgeListInput.Type;

export const ProjectKnowledgeListResult = Schema.Struct({
  projectId: ProjectId,
  files: Schema.Array(ProjectKnowledgeFileSummary),
});
export type ProjectKnowledgeListResult = typeof ProjectKnowledgeListResult.Type;

export const ProjectKnowledgeGetInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectKnowledgeFileName,
  startLine: Schema.optional(PositiveInt),
  endLine: Schema.optional(PositiveInt),
});
export type ProjectKnowledgeGetInput = typeof ProjectKnowledgeGetInput.Type;

export const ProjectKnowledgeGetResult = Schema.Struct({
  projectId: ProjectId,
  name: ProjectKnowledgeFileName,
  content: Schema.String,
  startLine: PositiveInt,
  endLine: NonNegativeInt,
  totalLines: NonNegativeInt,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectKnowledgeGetResult = typeof ProjectKnowledgeGetResult.Type;

export const ProjectKnowledgeAddInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectKnowledgeFileName,
  content: Schema.String,
});
export type ProjectKnowledgeAddInput = typeof ProjectKnowledgeAddInput.Type;

export const ProjectKnowledgeAddResult = Schema.Struct({
  projectId: ProjectId,
  name: ProjectKnowledgeFileName,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ProjectKnowledgeAddResult = typeof ProjectKnowledgeAddResult.Type;

export const ProjectKnowledgeDeleteInput = Schema.Struct({
  projectId: ProjectId,
  name: ProjectKnowledgeFileName,
});
export type ProjectKnowledgeDeleteInput = typeof ProjectKnowledgeDeleteInput.Type;

export const ProjectKnowledgeDeleteResult = Schema.Struct({
  projectId: ProjectId,
  name: ProjectKnowledgeFileName,
  deleted: Schema.Boolean,
});
export type ProjectKnowledgeDeleteResult = typeof ProjectKnowledgeDeleteResult.Type;

export const ProjectMemoryFailure = Schema.Literals([
  "project_not_found",
  "invalid_file_name",
  "invalid_line_range",
  "memory_too_large",
  "knowledge_file_too_large",
  "knowledge_file_count_exceeded",
  "knowledge_file_not_found",
  "operation_failed",
]);
export type ProjectMemoryFailure = typeof ProjectMemoryFailure.Type;

export class ProjectMemoryRpcError extends Schema.TaggedError<ProjectMemoryRpcError>()(
  "ProjectMemoryRpcError",
  {
    projectId: Schema.optional(ProjectId),
    fileName: Schema.optional(Schema.String),
    failure: ProjectMemoryFailure,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
