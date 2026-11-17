// @effect-diagnostics nodeBuiltinImport:off -- encodeProjectMemoryDirName hashes synchronously and lstat checks symlinks without following.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
  PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH,
  PROJECT_KNOWLEDGE_MAX_FILES,
  PROJECT_MEMORY_MAX_BYTES,
  ProjectKnowledgeFileName,
  type ProjectId,
  type ProjectKnowledgeAddResult,
  type ProjectKnowledgeDeleteResult,
  type ProjectKnowledgeFileSummary,
  type ProjectKnowledgeGetResult,
  type ProjectMemoryGetResult,
  type ProjectMemorySetResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const SEARCH_CHUNK_LINE_COUNT = 40;
const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_SNIPPET_MAX_CHARS = 4_000;
const SAFE_DIR_MAX_LENGTH = 128;

const WINDOWS_RESERVED_BASENAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export class ProjectMemoryValidationError extends Schema.TaggedError<ProjectMemoryValidationError>()(
  "ProjectMemoryValidationError",
  {
    reason: Schema.Literals([
      "invalid_file_name",
      "invalid_heading",
      "invalid_line_range",
      "invalid_query",
    ]),
    message: Schema.String,
  },
) {}

export class ProjectMemoryLimitError extends Schema.TaggedError<ProjectMemoryLimitError>()(
  "ProjectMemoryLimitError",
  {
    reason: Schema.Literals([
      "memory_too_large",
      "knowledge_file_too_large",
      "knowledge_file_count_exceeded",
    ]),
    limit: Schema.Number,
    actual: Schema.Number,
    message: Schema.String,
  },
) {}

export class ProjectMemoryNotFoundError extends Schema.TaggedError<ProjectMemoryNotFoundError>()(
  "ProjectMemoryNotFoundError",
  {
    fileName: Schema.String,
    message: Schema.String,
  },
) {}

export class ProjectMemoryStorageError extends Schema.TaggedError<ProjectMemoryStorageError>()(
  "ProjectMemoryStorageError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ProjectMemoryError =
  | ProjectMemoryValidationError
  | ProjectMemoryLimitError
  | ProjectMemoryNotFoundError
  | ProjectMemoryStorageError;

export interface ProjectKnowledgeSearchMatch {
  readonly name: ProjectKnowledgeFileName;
  readonly startLine: typeof PositiveInt.Type;
  readonly endLine: typeof PositiveInt.Type;
  readonly score: number;
  readonly snippet: string;
}

export interface ProjectMemoryStoreShape {
  readonly readMemory: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectMemoryGetResult, ProjectMemoryError>;
  readonly writeMemory: (
    projectId: ProjectId,
    content: string,
  ) => Effect.Effect<ProjectMemorySetResult, ProjectMemoryError>;
  readonly appendMemory: (
    projectId: ProjectId,
    text: string,
  ) => Effect.Effect<ProjectMemorySetResult, ProjectMemoryError>;
  readonly replaceMemorySection: (
    projectId: ProjectId,
    heading: string,
    body: string,
  ) => Effect.Effect<ProjectMemorySetResult, ProjectMemoryError>;
  readonly listKnowledge: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ProjectKnowledgeFileSummary>, ProjectMemoryError>;
  readonly readKnowledge: (
    projectId: ProjectId,
    name: string,
    options?: {
      readonly startLine?: number | undefined;
      readonly endLine?: number | undefined;
    },
  ) => Effect.Effect<ProjectKnowledgeGetResult, ProjectMemoryError>;
  readonly addKnowledge: (
    projectId: ProjectId,
    name: string,
    content: string,
  ) => Effect.Effect<ProjectKnowledgeAddResult, ProjectMemoryError>;
  readonly deleteKnowledge: (
    projectId: ProjectId,
    name: string,
  ) => Effect.Effect<ProjectKnowledgeDeleteResult, ProjectMemoryError>;
  readonly searchKnowledge: (
    projectId: ProjectId,
    query: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ProjectKnowledgeSearchMatch>, ProjectMemoryError>;
}

export class ProjectMemoryStore extends Context.Service<
  ProjectMemoryStore,
  ProjectMemoryStoreShape
>()("t3/projectMemory/ProjectMemoryStore") {}

/**
 * Derive a deterministic, collision-free directory name using only [A-Za-z0-9_-].
 * Characters outside [A-Za-z0-9-] (including "_" and ":") are encoded as "_<hex>_",
 * avoiding Windows-invalid characters (like ":") and "." / ".." segments.
 */
export function encodeProjectMemoryDirName(projectId: ProjectId): string {
  const bytes = Buffer.from(projectId, "utf8");
  let encoded = "";
  for (const byte of bytes) {
    const isAsciiAlphaNumOrDash =
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      byte === 0x2d; // -
    if (isAsciiAlphaNumOrDash) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `_${byte.toString(16).padStart(2, "0")}_`;
    }
  }
  if (encoded.length === 0) {
    return "_empty_";
  }
  if (encoded.length <= SAFE_DIR_MAX_LENGTH) {
    return encoded;
  }
  const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${encoded.slice(0, 96)}__${digest}`;
}

function isStagingEntryName(name: string): boolean {
  return name.includes(".staging-");
}

function validateKnowledgeFileName(
  rawName: string,
): Effect.Effect<ProjectKnowledgeFileName, ProjectMemoryValidationError> {
  if (
    rawName.length === 0 ||
    rawName.trim() !== rawName ||
    rawName.length > PROJECT_KNOWLEDGE_FILE_NAME_MAX_LENGTH
  ) {
    return Effect.fail(
      new ProjectMemoryValidationError({
        reason: "invalid_file_name",
        message: "Knowledge file name must be a non-empty trimmed string up to 200 characters.",
      }),
    );
  }
  if (
    rawName === "." ||
    rawName === ".." ||
    rawName.includes("/") ||
    rawName.includes("\\") ||
    rawName.includes(":") ||
    rawName.endsWith(".") ||
    isStagingEntryName(rawName)
  ) {
    return Effect.fail(
      new ProjectMemoryValidationError({
        reason: "invalid_file_name",
        message: "Knowledge file name contains disallowed path or staging characters.",
      }),
    );
  }
  for (let i = 0; i < rawName.length; i += 1) {
    const code = rawName.charCodeAt(i);
    const ch = rawName[i]!;
    if (code < 0x20 || code === 0x7f || '<>"|?*'.includes(ch)) {
      return Effect.fail(
        new ProjectMemoryValidationError({
          reason: "invalid_file_name",
          message: "Knowledge file name contains invalid filename characters.",
        }),
      );
    }
  }
  const baseWithoutExt = rawName.split(".")[0]?.toUpperCase() ?? "";
  if (WINDOWS_RESERVED_BASENAMES.has(baseWithoutExt)) {
    return Effect.fail(
      new ProjectMemoryValidationError({
        reason: "invalid_file_name",
        message: "Knowledge file name uses a reserved device name.",
      }),
    );
  }
  return Effect.succeed(ProjectKnowledgeFileName.make(rawName));
}

function normalizeSectionHeading(
  rawHeading: string,
): Effect.Effect<string, ProjectMemoryValidationError> {
  const stripped = rawHeading
    .trim()
    .replace(/^##\s+/, "")
    .trim();
  if (stripped.length === 0 || stripped.includes("\n") || stripped.includes("\r")) {
    return Effect.fail(
      new ProjectMemoryValidationError({
        reason: "invalid_heading",
        message: "Memory section heading must be a single non-empty line.",
      }),
    );
  }
  return Effect.succeed(stripped);
}

export function applyMemorySectionReplacement(
  existingContent: string,
  heading: string,
  body: string,
): string {
  const normalizedExisting = existingContent.replace(/\r\n/g, "\n");
  const normalizedBody = body.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalizedExisting.length === 0 ? [] : normalizedExisting.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let inFence: string | null = null;
  let matchStart = -1;
  let matchEnd = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      if (inFence === null) {
        inFence = fence;
      } else if (line.trimStart().startsWith(inFence)) {
        inFence = null;
      }
      continue;
    }
    if (inFence !== null) continue;

    if (matchStart === -1) {
      const h2Match = line.match(/^##\s+(.+?)\s*$/);
      if (h2Match && h2Match[1]!.trim() === heading) {
        matchStart = i;
      }
    } else if (/^#{1,2}\s+/.test(line)) {
      matchEnd = i;
      break;
    }
  }

  const replacementBlock: Array<string> =
    normalizedBody.length > 0 ? [`## ${heading}`, normalizedBody] : [`## ${heading}`];

  if (matchStart !== -1) {
    const before = lines.slice(0, matchStart);
    const after = lines.slice(matchEnd);
    const nextLines: Array<string> = [...before, ...replacementBlock];
    if (after.length > 0) {
      nextLines.push("", ...after);
    }
    return `${nextLines.join("\n")}\n`;
  }

  const trimmedLines = [...lines];
  while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1] === "") {
    trimmedLines.pop();
  }
  const nextLines =
    trimmedLines.length === 0 ? replacementBlock : [...trimmedLines, "", ...replacementBlock];
  return `${nextLines.join("\n")}\n`;
}

function splitContentLines(content: string): Array<string> {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const projectsRoot = path.join(config.stateDir, "projects");
  const projectLocks = new Map<string, Semaphore.Semaphore>();

  const lockFor = (safeId: string): Semaphore.Semaphore => {
    let lock = projectLocks.get(safeId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      projectLocks.set(safeId, lock);
    }
    return lock;
  };

  const withProjectLock = <A, E>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> => lockFor(encodeProjectMemoryDirName(projectId)).withPermits(1)(effect);

  const projectDirFor = (projectId: ProjectId): string =>
    path.join(projectsRoot, encodeProjectMemoryDirName(projectId));

  const memoryFilePathFor = (projectId: ProjectId): string =>
    path.join(projectDirFor(projectId), "MEMORY.md");

  const knowledgeDirFor = (projectId: ProjectId): string =>
    path.join(projectDirFor(projectId), "knowledge");

  const lstatOptional = (targetPath: string, operation: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return Option.some(await NodeFSP.lstat(targetPath));
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return Option.none();
          }
          throw error;
        }
      },
      catch: (cause) =>
        new ProjectMemoryStorageError({
          operation,
          message: "Failed to inspect project memory path.",
          cause,
        }),
    });

  const assertRegularPathIfPresent = Effect.fn("ProjectMemoryStore.assertRegularPathIfPresent")(
    function* (targetPath: string, expectedType: "file" | "directory", operation: string) {
      const statOpt = yield* lstatOptional(targetPath, operation);
      if (Option.isNone(statOpt)) return Option.none<Awaited<ReturnType<typeof NodeFSP.lstat>>>();
      const stat = statOpt.value;
      if (stat.isSymbolicLink()) {
        return yield* new ProjectMemoryStorageError({
          operation,
          message: "Symbolic links are not allowed in project memory storage.",
        });
      }
      if (expectedType === "file" && !stat.isFile()) {
        return yield* new ProjectMemoryStorageError({
          operation,
          message: "Expected a regular file in project memory storage.",
        });
      }
      if (expectedType === "directory" && !stat.isDirectory()) {
        return yield* new ProjectMemoryStorageError({
          operation,
          message: "Expected a directory in project memory storage.",
        });
      }
      return statOpt;
    },
  );

  const ensureDirectories = Effect.fn("ProjectMemoryStore.ensureDirectories")(function* (
    dirs: ReadonlyArray<string>,
    operation: string,
  ) {
    for (const dir of dirs) {
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectMemoryStorageError({
              operation,
              message: "Failed to create project memory directory.",
              cause,
            }),
        ),
      );
      yield* assertRegularPathIfPresent(dir, "directory", operation);
    }
  });

  const writeAtomicString = Effect.fn("ProjectMemoryStore.writeAtomicString")(function* (
    targetPath: string,
    content: string,
    operation: string,
  ) {
    yield* assertRegularPathIfPresent(targetPath, "file", operation);
    const staging = `${targetPath}.staging-${process.pid}-${NodeCrypto.randomUUID()}`;
    yield* fs.remove(staging, { force: true }).pipe(
      Effect.andThen(fs.writeFileString(staging, content, { flag: "wx" })),
      Effect.andThen(fs.rename(staging, targetPath)),
      Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new ProjectMemoryStorageError({
            operation,
            message: "Failed to write project memory file atomically.",
            cause,
          }),
      ),
    );
    const statOpt = yield* assertRegularPathIfPresent(targetPath, "file", operation);
    if (Option.isNone(statOpt)) {
      return yield* new ProjectMemoryStorageError({
        operation,
        message: "Written project memory file could not be verified.",
      });
    }
    return statOpt.value;
  });

  const readFileStringChecked = Effect.fn("ProjectMemoryStore.readFileStringChecked")(function* (
    targetPath: string,
    operation: string,
  ) {
    const statOpt = yield* assertRegularPathIfPresent(targetPath, "file", operation);
    if (Option.isNone(statOpt)) {
      return Option.none<{
        readonly content: string;
        readonly stat: Awaited<ReturnType<typeof NodeFSP.lstat>>;
      }>();
    }
    const content = yield* fs.readFileString(targetPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectMemoryStorageError({
            operation,
            message: "Failed to read project memory file.",
            cause,
          }),
      ),
    );
    return Option.some({ content, stat: statOpt.value });
  });

  const readMemory: ProjectMemoryStoreShape["readMemory"] = Effect.fn(
    "ProjectMemoryStore.readMemory",
  )(function* (projectId) {
    const filePath = memoryFilePathFor(projectId);
    const result = yield* readFileStringChecked(filePath, "readMemory");
    if (Option.isNone(result)) {
      return {
        projectId,
        exists: false,
        content: "",
        sizeBytes: NonNegativeInt.make(0),
        updatedAt: null,
      };
    }
    const { content, stat } = result.value;
    return {
      projectId,
      exists: true,
      content,
      sizeBytes: NonNegativeInt.make(Buffer.byteLength(content, "utf8")),
      updatedAt: IsoDateTime.make(stat.mtime.toISOString()),
    };
  });

  const writeMemoryUnlocked = Effect.fn("ProjectMemoryStore.writeMemoryUnlocked")(function* (
    projectId: ProjectId,
    content: string,
    operation: string,
  ) {
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > PROJECT_MEMORY_MAX_BYTES) {
      return yield* new ProjectMemoryLimitError({
        reason: "memory_too_large",
        limit: PROJECT_MEMORY_MAX_BYTES,
        actual: sizeBytes,
        message: `Project memory exceeds the ${PROJECT_MEMORY_MAX_BYTES} byte limit.`,
      });
    }
    const projectDir = projectDirFor(projectId);
    yield* ensureDirectories([projectsRoot, projectDir], operation);
    const stat = yield* writeAtomicString(memoryFilePathFor(projectId), content, operation);
    return {
      projectId,
      sizeBytes: NonNegativeInt.make(sizeBytes),
      updatedAt: IsoDateTime.make(stat.mtime.toISOString()),
    };
  });

  const writeMemory: ProjectMemoryStoreShape["writeMemory"] = Effect.fn(
    "ProjectMemoryStore.writeMemory",
  )(function* (projectId, content) {
    return yield* withProjectLock(
      projectId,
      writeMemoryUnlocked(projectId, content, "writeMemory"),
    );
  });

  const appendMemory: ProjectMemoryStoreShape["appendMemory"] = Effect.fn(
    "ProjectMemoryStore.appendMemory",
  )(function* (projectId, text) {
    return yield* withProjectLock(
      projectId,
      Effect.gen(function* () {
        const current = yield* readFileStringChecked(memoryFilePathFor(projectId), "appendMemory");
        const existing = Option.isSome(current) ? current.value.content : "";
        let next: string;
        if (existing.length === 0) {
          next = text;
        } else if (text.length === 0) {
          next = existing;
        } else if (existing.endsWith("\n")) {
          next = `${existing}${text}`;
        } else {
          next = `${existing}\n${text}`;
        }
        return yield* writeMemoryUnlocked(projectId, next, "appendMemory");
      }),
    );
  });

  const replaceMemorySection: ProjectMemoryStoreShape["replaceMemorySection"] = Effect.fn(
    "ProjectMemoryStore.replaceMemorySection",
  )(function* (projectId, rawHeading, body) {
    const heading = yield* normalizeSectionHeading(rawHeading);
    return yield* withProjectLock(
      projectId,
      Effect.gen(function* () {
        const current = yield* readFileStringChecked(
          memoryFilePathFor(projectId),
          "replaceMemorySection",
        );
        const existing = Option.isSome(current) ? current.value.content : "";
        const next = applyMemorySectionReplacement(existing, heading, body);
        return yield* writeMemoryUnlocked(projectId, next, "replaceMemorySection");
      }),
    );
  });

  const resolveKnowledgeFilePath = Effect.fn("ProjectMemoryStore.resolveKnowledgeFilePath")(
    function* (projectId: ProjectId, rawName: string) {
      const name = yield* validateKnowledgeFileName(rawName);
      const knowledgeDir = knowledgeDirFor(projectId);
      const filePath = path.join(knowledgeDir, name);
      if (path.dirname(filePath) !== knowledgeDir || path.basename(filePath) !== name) {
        return yield* new ProjectMemoryValidationError({
          reason: "invalid_file_name",
          message: "Knowledge file path escaped the project knowledge directory.",
        });
      }
      return { name, knowledgeDir, filePath };
    },
  );

  const listKnowledge: ProjectMemoryStoreShape["listKnowledge"] = Effect.fn(
    "ProjectMemoryStore.listKnowledge",
  )(function* (projectId) {
    const knowledgeDir = knowledgeDirFor(projectId);
    const dirStat = yield* assertRegularPathIfPresent(knowledgeDir, "directory", "listKnowledge");
    if (Option.isNone(dirStat)) return [];

    const entries = yield* fs.readDirectory(knowledgeDir).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectMemoryStorageError({
            operation: "listKnowledge",
            message: "Failed to list project knowledge directory.",
            cause,
          }),
      ),
    );

    const summaries: Array<ProjectKnowledgeFileSummary> = [];
    for (const entry of entries) {
      if (isStagingEntryName(entry)) continue;
      const validName = yield* validateKnowledgeFileName(entry).pipe(Effect.option);
      if (Option.isNone(validName)) continue;
      const entryPath = path.join(knowledgeDir, validName.value);
      const statOpt = yield* lstatOptional(entryPath, "listKnowledge");
      if (Option.isNone(statOpt)) continue;
      const stat = statOpt.value;
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      summaries.push({
        name: validName.value,
        sizeBytes: NonNegativeInt.make(Number(stat.size)),
        updatedAt: IsoDateTime.make(stat.mtime.toISOString()),
      });
    }

    summaries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return summaries;
  });

  const readKnowledge: ProjectMemoryStoreShape["readKnowledge"] = Effect.fn(
    "ProjectMemoryStore.readKnowledge",
  )(function* (projectId, rawName, options) {
    const { name, filePath } = yield* resolveKnowledgeFilePath(projectId, rawName);
    const startLine = options?.startLine;
    const endLine = options?.endLine;
    if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
      return yield* new ProjectMemoryValidationError({
        reason: "invalid_line_range",
        message: "startLine must be a positive integer.",
      });
    }
    if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
      return yield* new ProjectMemoryValidationError({
        reason: "invalid_line_range",
        message: "endLine must be a positive integer.",
      });
    }
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      return yield* new ProjectMemoryValidationError({
        reason: "invalid_line_range",
        message: "endLine must be greater than or equal to startLine.",
      });
    }

    const result = yield* readFileStringChecked(filePath, "readKnowledge");
    if (Option.isNone(result)) {
      return yield* new ProjectMemoryNotFoundError({
        fileName: name,
        message: `Knowledge file "${name}" was not found.`,
      });
    }

    const { content: rawContent, stat } = result.value;
    const sizeBytes = NonNegativeInt.make(Buffer.byteLength(rawContent, "utf8"));
    const updatedAt = IsoDateTime.make(stat.mtime.toISOString());
    const lines = splitContentLines(rawContent);
    const totalLines = NonNegativeInt.make(lines.length);

    if (startLine === undefined && endLine === undefined) {
      return {
        projectId,
        name,
        content: rawContent,
        startLine: PositiveInt.make(1),
        endLine: totalLines,
        totalLines,
        sizeBytes,
        updatedAt,
      };
    }

    const effectiveStart = startLine ?? 1;
    const effectiveEnd = Math.min(endLine ?? lines.length, lines.length);
    const sliced =
      effectiveStart > lines.length || effectiveEnd < effectiveStart
        ? ""
        : lines.slice(effectiveStart - 1, effectiveEnd).join("\n");

    return {
      projectId,
      name,
      content: sliced,
      startLine: PositiveInt.make(effectiveStart),
      endLine: NonNegativeInt.make(effectiveEnd >= effectiveStart ? effectiveEnd : 0),
      totalLines,
      sizeBytes,
      updatedAt,
    };
  });

  const addKnowledge: ProjectMemoryStoreShape["addKnowledge"] = Effect.fn(
    "ProjectMemoryStore.addKnowledge",
  )(function* (projectId, rawName, content) {
    const { name, knowledgeDir, filePath } = yield* resolveKnowledgeFilePath(projectId, rawName);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > PROJECT_KNOWLEDGE_FILE_MAX_BYTES) {
      return yield* new ProjectMemoryLimitError({
        reason: "knowledge_file_too_large",
        limit: PROJECT_KNOWLEDGE_FILE_MAX_BYTES,
        actual: sizeBytes,
        message: `Knowledge file "${name}" exceeds the ${PROJECT_KNOWLEDGE_FILE_MAX_BYTES} byte limit.`,
      });
    }

    return yield* withProjectLock(
      projectId,
      Effect.gen(function* () {
        const projectDir = projectDirFor(projectId);
        yield* ensureDirectories([projectsRoot, projectDir, knowledgeDir], "addKnowledge");

        const existingStat = yield* assertRegularPathIfPresent(filePath, "file", "addKnowledge");
        if (Option.isNone(existingStat)) {
          const existingFiles = yield* listKnowledge(projectId);
          if (existingFiles.length >= PROJECT_KNOWLEDGE_MAX_FILES) {
            return yield* new ProjectMemoryLimitError({
              reason: "knowledge_file_count_exceeded",
              limit: PROJECT_KNOWLEDGE_MAX_FILES,
              actual: existingFiles.length,
              message: `Project knowledge directory already has the maximum of ${PROJECT_KNOWLEDGE_MAX_FILES} files.`,
            });
          }
        }

        const stat = yield* writeAtomicString(filePath, content, "addKnowledge");
        return {
          projectId,
          name,
          sizeBytes: NonNegativeInt.make(sizeBytes),
          updatedAt: IsoDateTime.make(stat.mtime.toISOString()),
        };
      }),
    );
  });

  const deleteKnowledge: ProjectMemoryStoreShape["deleteKnowledge"] = Effect.fn(
    "ProjectMemoryStore.deleteKnowledge",
  )(function* (projectId, rawName) {
    const { name, filePath } = yield* resolveKnowledgeFilePath(projectId, rawName);
    return yield* withProjectLock(
      projectId,
      Effect.gen(function* () {
        const existing = yield* assertRegularPathIfPresent(filePath, "file", "deleteKnowledge");
        if (Option.isNone(existing)) {
          return yield* new ProjectMemoryNotFoundError({
            fileName: name,
            message: `Knowledge file "${name}" was not found.`,
          });
        }
        yield* fs.remove(filePath).pipe(
          Effect.mapError(
            (cause) =>
              new ProjectMemoryStorageError({
                operation: "deleteKnowledge",
                message: "Failed to delete project knowledge file.",
                cause,
              }),
          ),
        );
        return {
          projectId,
          name,
          deleted: true,
        };
      }),
    );
  });

  const searchKnowledge: ProjectMemoryStoreShape["searchKnowledge"] = Effect.fn(
    "ProjectMemoryStore.searchKnowledge",
  )(function* (projectId, rawQuery, rawLimit) {
    const trimmedQuery = rawQuery.trim();
    if (trimmedQuery.length === 0) {
      return yield* new ProjectMemoryValidationError({
        reason: "invalid_query",
        message: "Search query must not be empty.",
      });
    }
    const limit = Math.min(
      Math.max(Math.trunc(rawLimit ?? SEARCH_DEFAULT_LIMIT), 1),
      SEARCH_MAX_LIMIT,
    );
    const phraseLower = trimmedQuery.toLowerCase();
    const terms = Array.from(new Set(phraseLower.split(/\s+/).filter((term) => term.length > 0)));
    if (terms.length === 0) return [];

    const files = yield* listKnowledge(projectId);
    const matches: Array<ProjectKnowledgeSearchMatch> = [];
    const knowledgeDir = knowledgeDirFor(projectId);

    for (const file of files) {
      const filePath = path.join(knowledgeDir, file.name);
      const readResult = yield* readFileStringChecked(filePath, "searchKnowledge");
      if (Option.isNone(readResult)) continue;

      const lines = splitContentLines(readResult.value.content);
      if (lines.length === 0) continue;

      const fileNameLower = file.name.toLowerCase();
      const fileBonus = fileNameLower.includes(phraseLower)
        ? 4
        : terms.some((term) => fileNameLower.includes(term))
          ? 2
          : 0;

      for (let start = 0; start < lines.length; start += SEARCH_CHUNK_LINE_COUNT) {
        const chunkLines = lines.slice(start, start + SEARCH_CHUNK_LINE_COUNT);
        const chunkText = chunkLines.join("\n");
        const chunkLower = chunkText.toLowerCase();

        let matchedTerms = 0;
        let totalHits = 0;
        for (const term of terms) {
          const hits = countOccurrences(chunkLower, term);
          if (hits > 0) {
            matchedTerms += 1;
            totalHits += Math.min(hits, 5);
          }
        }
        if (matchedTerms === 0) continue;

        const phraseBonus = chunkLower.includes(phraseLower) ? 10 : 0;
        const score = matchedTerms * 10 + totalHits + phraseBonus + fileBonus;
        const snippet =
          chunkText.length > SEARCH_SNIPPET_MAX_CHARS
            ? `${chunkText.slice(0, SEARCH_SNIPPET_MAX_CHARS)}...`
            : chunkText;

        matches.push({
          name: file.name,
          startLine: PositiveInt.make(start + 1),
          endLine: PositiveInt.make(start + chunkLines.length),
          score,
          snippet,
        });
      }
    }

    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.startLine - b.startLine;
    });

    return matches.slice(0, limit);
  });

  return {
    readMemory,
    writeMemory,
    appendMemory,
    replaceMemorySection,
    listKnowledge,
    readKnowledge,
    addKnowledge,
    deleteKnowledge,
    searchKnowledge,
  } satisfies ProjectMemoryStoreShape;
});

export const layer: Layer.Layer<
  ProjectMemoryStore,
  never,
  FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
> = Layer.effect(ProjectMemoryStore, make);
