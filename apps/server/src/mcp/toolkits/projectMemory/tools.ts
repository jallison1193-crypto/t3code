import {
  clampedPositiveInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  ProjectKnowledgeAddResult,
  ProjectKnowledgeDeleteResult,
  ProjectKnowledgeFileName,
  ProjectKnowledgeFileSummary,
  ProjectKnowledgeGetResult,
  ProjectMemoryGetResult,
  ProjectMemorySetResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectMemoryStore from "../../../projectMemory/ProjectMemoryStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    ProjectMemoryStore.ProjectMemoryStore,
  ],
};

const ProjectMemoryReadTool = Tool.make("t3_project_memory_read", {
  ...shared,
  description: "Read project memory (MEMORY.md). Defaults to the caller thread's project.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
  }),
  success: ProjectMemoryGetResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ProjectMemoryWriteTool = Tool.make("t3_project_memory_write", {
  ...shared,
  description:
    "Write project memory (MEMORY.md). mode='replace' overwrites, 'append' appends, 'replace_section' replaces or adds a ## heading section.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    mode: Schema.Literals(["replace", "append", "replace_section"]),
    content: Schema.String,
    heading: Schema.optional(TrimmedNonEmptyString),
  }),
  success: ProjectMemorySetResult,
}).annotate(Tool.Destructive, true);

const ProjectKnowledgeListTool = Tool.make("t3_project_knowledge_list", {
  ...shared,
  description: "List project knowledge files. Defaults to the caller thread's project.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    projectId: ProjectId,
    files: Schema.Array(ProjectKnowledgeFileSummary),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ProjectKnowledgeSearchTool = Tool.make("t3_project_knowledge_search", {
  ...shared,
  description: "Keyword-search project knowledge files. Returns ranked file/line snippets.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    query: TrimmedNonEmptyString,
    limit: Schema.optional(clampedPositiveInt(50)),
  }),
  success: Schema.Struct({
    projectId: ProjectId,
    matches: Schema.Array(
      Schema.Struct({
        name: ProjectKnowledgeFileName,
        startLine: PositiveInt,
        endLine: PositiveInt,
        score: Schema.Number,
        snippet: Schema.String,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ProjectKnowledgeReadTool = Tool.make("t3_project_knowledge_read", {
  ...shared,
  description: "Read a project knowledge file by name, with optional 1-based line range.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    name: ProjectKnowledgeFileName,
    startLine: Schema.optional(PositiveInt),
    endLine: Schema.optional(PositiveInt),
  }),
  success: ProjectKnowledgeGetResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ProjectKnowledgeAddTool = Tool.make("t3_project_knowledge_add", {
  ...shared,
  description: "Create or overwrite a project knowledge file using provided text content.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    name: ProjectKnowledgeFileName,
    content: Schema.String,
  }),
  success: ProjectKnowledgeAddResult,
}).annotate(Tool.Destructive, true);

const ProjectKnowledgeDeleteTool = Tool.make("t3_project_knowledge_delete", {
  ...shared,
  description: "Delete a project knowledge file by name.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optional(ProjectId),
    name: ProjectKnowledgeFileName,
  }),
  success: ProjectKnowledgeDeleteResult,
}).annotate(Tool.Destructive, true);

export const ProjectMemoryToolkit = Toolkit.make(
  ProjectMemoryReadTool,
  ProjectMemoryWriteTool,
  ProjectKnowledgeListTool,
  ProjectKnowledgeSearchTool,
  ProjectKnowledgeReadTool,
  ProjectKnowledgeAddTool,
  ProjectKnowledgeDeleteTool,
);
