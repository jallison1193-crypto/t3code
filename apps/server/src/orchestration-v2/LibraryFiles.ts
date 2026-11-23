import {
  type OrchestrationV2ListLibraryFilesInput,
  type OrchestrationV2ListLibraryFilesResult,
  ProjectId,
  StoredThreadTags,
  ThreadId,
  TurnItemId,
  WORK_MODE_TAG,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  fileDisplayName,
  isAbsolutePath,
  isNetworkPath,
  isUncPath,
  isWindowsDrivePath,
  isWslSharePath,
  resolveWorkspaceFilePath,
  stripSlashPrefixedWindowsDrive,
} from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as NodeOS from "node:os";

const CANDIDATE_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;

const decodeFileChangeItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      fileName: Schema.optionalKey(Schema.String),
      changes: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            operation: Schema.String,
            path: Schema.String,
            oldPath: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
);
const decodeTags = Schema.decodeUnknownOption(Schema.fromJsonString(StoredThreadTags));

interface Candidate {
  readonly itemId: string;
  readonly updatedAt: string;
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly worktreePath: string | null;
  readonly projectWorkspaceRoot: string | null;
  readonly tags: string | null;
  readonly payload: string | null;
}

type LibraryFileEntry = OrchestrationV2ListLibraryFilesResult["entries"][number];

function isDeleteOperation(operation: string): boolean {
  const normalized = operation.trim().toLowerCase();
  return (
    normalized === "delete" ||
    normalized === "deleted" ||
    normalized === "remove" ||
    normalized === "removed"
  );
}

function normalizePathSegments(segments: ReadonlyArray<string>): Array<string> {
  const out: Array<string> = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

function normalizeLibraryFilePath(rawPath: string, workspaceRoot?: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return null;

  let stripped = stripSlashPrefixedWindowsDrive(trimmed);
  if (!isAbsolutePath(stripped)) {
    if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) return null;
    stripped = stripSlashPrefixedWindowsDrive(
      resolveWorkspaceFilePath(stripped, workspaceRoot.trim()),
    );
  }
  if (isNetworkPath(stripped) && !isWslSharePath(stripped)) return null;

  if (isWindowsDrivePath(stripped)) {
    const drive = stripped.slice(0, 2).toUpperCase();
    const segments = normalizePathSegments(stripped.slice(2).split(/[\\/]+/));
    return segments.length === 0 ? null : `${drive}\\${segments.join("\\")}`;
  }

  if (isUncPath(stripped)) {
    const parts = stripped.replace(/^\\+/, "").split(/[\\/]+/);
    const host = parts[0];
    const share = parts[1];
    const segments = normalizePathSegments(parts.slice(2));
    if (!host || !share || segments.length === 0) return null;
    return `\\\\${host}\\${share}\\${segments.join("\\")}`;
  }

  if (!stripped.startsWith("/")) return null;
  const segments = normalizePathSegments(stripped.split("/"));
  return segments.length === 0 ? null : `/${segments.join("/")}`;
}

function isInsideFolder(path: string, folder: string, isWindows: boolean): boolean {
  const [p, f] = isWindows ? [path.toLowerCase(), folder.toLowerCase()] : [path, folder];
  const separator = f.startsWith("/") ? "/" : "\\";
  return p.startsWith(f.endsWith(separator) ? f : `${f}${separator}`);
}

function dedupeKey(projectId: string, normalizedPath: string, isWindows: boolean): string {
  return `${projectId}\0${isWindows ? normalizedPath.toLowerCase() : normalizedPath}`;
}

export class LibraryFiles extends Context.Service<
  LibraryFiles,
  {
    readonly list: (
      input: OrchestrationV2ListLibraryFilesInput,
    ) => Effect.Effect<OrchestrationV2ListLibraryFilesResult, SqlError>;
  }
>()("t3/orchestration-v2/LibraryFiles") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  // Fork-only index: a numbered migration would collide with upstream's next migration id.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_library_files_idx
    ON orchestration_v2_projection_turn_items(updated_at DESC, turn_item_id DESC)
    WHERE type = 'file_change' AND status = 'completed'
  `;

  const list = Effect.fn("LibraryFiles.list")(function* ({
    projectIds,
    mode = "all",
    limit = DEFAULT_PAGE_SIZE,
    cursor,
  }: OrchestrationV2ListLibraryFilesInput) {
    if (projectIds?.length === 0) return { entries: [], nextCursor: null };
    const isWindows = (yield* HostProcess.Platform) === "win32";
    const tempRoot = normalizeLibraryFilePath(NodeOS.tmpdir());

    // Filter in the SELECT so even a sparse project or mode examines a bounded batch.
    const rows = yield* sql<Candidate>`
      SELECT
        item.turn_item_id AS itemId, item.updated_at AS updatedAt, item.thread_id AS threadId,
        thread.title AS threadTitle, project.project_id AS projectId, project.title AS projectTitle,
        CASE WHEN json_valid(thread.payload_json) THEN thread.payload_json ->> '$.worktreePath' END AS worktreePath,
        project.workspace_root AS projectWorkspaceRoot,
        CASE WHEN json_valid(thread.payload_json) THEN thread.payload_json -> '$.tags' END AS tags,
        CASE WHEN thread.deleted_at IS NULL AND project.deleted_at IS NULL
          AND project.project_id IS NOT NULL AND run.status IS NOT 'rolled_back'
          ${projectIds === undefined ? sql`` : sql`AND project.project_id IN ${sql.in(projectIds)}`}
          THEN item.payload_json END AS payload
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
      LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
      WHERE item.type = 'file_change' AND item.status = 'completed'
        ${
          cursor === undefined
            ? sql``
            : sql`AND (item.updated_at, item.turn_item_id) < (${cursor.updatedAt}, ${cursor.itemId})`
        }
      ORDER BY item.updated_at DESC, item.turn_item_id DESC
      LIMIT ${CANDIDATE_LIMIT + 1}
    `.pipe(NodeSqliteClient.readOnly);

    const entries: Array<LibraryFileEntry> = [];
    const seen = new Set<string>();
    let examined = 0;

    for (const row of rows.slice(0, CANDIDATE_LIMIT)) {
      examined++;
      if (
        row.payload === null ||
        row.threadTitle === null ||
        row.projectId === null ||
        row.projectTitle === null
      ) {
        continue;
      }
      const tags = Option.getOrUndefined(decodeTags(row.tags));
      const threadMode = tags?.includes(WORK_MODE_TAG) ? "work" : "code";
      if (mode !== "all" && mode !== threadMode) continue;

      const item = Option.getOrUndefined(decodeFileChangeItem(row.payload));
      if (item === undefined) continue;

      const workspaceRoot = row.worktreePath ?? row.projectWorkspaceRoot ?? undefined;
      const changes =
        item.changes !== undefined && item.changes.length > 0
          ? item.changes
          : item.fileName !== undefined && item.fileName.trim().length > 0
            ? [{ operation: "update", path: item.fileName }]
            : [];

      for (const change of changes) {
        const resolvedPath = normalizeLibraryFilePath(change.path, workspaceRoot);
        // Agent scratch files under the OS temp folder are throwaway, not work the thread produced.
        const normalizedPath =
          resolvedPath !== null &&
          tempRoot !== null &&
          isInsideFolder(resolvedPath, tempRoot, isWindows)
            ? null
            : resolvedPath;
        let key: string | null = null;
        if (normalizedPath !== null) {
          key = dedupeKey(row.projectId, normalizedPath, isWindows);
          if (!seen.has(key)) {
            seen.add(key);
            if (!isDeleteOperation(change.operation)) {
              const exists = yield* fileSystem
                .exists(normalizedPath)
                .pipe(Effect.orElseSucceed(() => false));
              if (exists) {
                entries.push({
                  path: normalizedPath,
                  fileName: fileDisplayName(normalizedPath),
                  itemId: TurnItemId.make(row.itemId),
                  threadId: ThreadId.make(row.threadId),
                  threadTitle: row.threadTitle,
                  projectId: ProjectId.make(row.projectId),
                  projectTitle: row.projectTitle,
                  ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
                  mode: threadMode,
                  updatedAt: row.updatedAt,
                });
              }
            }
          }
        }
        if (change.oldPath !== undefined) {
          const normalizedOldPath = normalizeLibraryFilePath(change.oldPath, workspaceRoot);
          if (normalizedOldPath !== null) {
            const oldKey = dedupeKey(row.projectId, normalizedOldPath, isWindows);
            if (oldKey !== key) seen.add(oldKey);
          }
        }
      }

      if (entries.length >= limit) break;
    }

    const last = rows[examined - 1];
    return {
      entries,
      nextCursor:
        last !== undefined && examined < rows.length
          ? { updatedAt: last.updatedAt, itemId: TurnItemId.make(last.itemId) }
          : null,
    };
  });

  return LibraryFiles.of({ list });
});

export const layer = Layer.effect(LibraryFiles, make);
