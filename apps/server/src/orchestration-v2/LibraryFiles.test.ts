import { ProjectId, ThreadId, TurnItemId, WORK_MODE_TAG } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";
import * as LibraryFiles from "./LibraryFiles.ts";

const at = "2026-11-21T13:00:00.000Z";

function makeTestLayer(exists: (path: string) => boolean = () => true) {
  return LibraryFiles.layer.pipe(
    Layer.provideMerge(
      Layer.merge(
        SqlitePersistence.layerMemory,
        FileSystem.layerNoop({
          exists: (path) => Effect.succeed(exists(path)),
        }),
      ),
    ),
  );
}

const addProject = Effect.fn("LibraryFilesTest.addProject")(function* (
  id: string,
  options: { workspaceRoot?: string; archived?: boolean; deleted?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, archived_at, deleted_at)
    VALUES (${id}, ${id}, ${options.workspaceRoot ?? `C:\\work\\${id}`}, '[]', ${at}, ${at},
      ${options.archived ? at : null}, ${options.deleted ? at : null})
  `;
});

const addThread = Effect.fn("LibraryFilesTest.addThread")(function* (
  id: string,
  options: {
    projectId?: string;
    archived?: boolean;
    deleted?: boolean;
    tags?: ReadonlyArray<string>;
    worktreePath?: string | null;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({
    tags: options.tags,
    worktreePath: options.worktreePath ?? null,
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${id}, ${options.projectId ?? "project"}, ${id}, 'codex', 'full-access', 'default',
      ${at}, ${at}, ${options.archived ? at : null}, ${options.deleted ? at : null}, ${payload})
  `;
});

const addFileChange = Effect.fn("LibraryFilesTest.addFileChange")(function* (
  id: string,
  thread: string,
  payload: unknown,
  options: { status?: string; runId?: string; updatedAt?: string } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
    VALUES (${id}, ${thread}, ${options.runId ?? null}, 1, 'file_change',
      ${options.status ?? "completed"}, ${options.updatedAt ?? at}, ${JSON.stringify(payload)})
  `;
});

describe("library files", () => {
  it.effect(
    "dedupes across slash-prefixed Windows and backslash paths keeping the newest change per project",
    () =>
      Effect.gen(function* () {
        const service = yield* LibraryFiles.LibraryFiles;
        yield* addProject("project", { workspaceRoot: "C:\\Users\\x" });
        yield* addProject("other", { workspaceRoot: "C:\\Users\\x" });
        yield* addThread("older-thread", { projectId: "project" });
        yield* addThread("newer-thread", { projectId: "project", tags: [WORK_MODE_TAG] });
        yield* addThread("other-thread", { projectId: "other" });

        yield* addFileChange(
          "item-1",
          "older-thread",
          { fileName: "C:\\Users\\x\\budget.xlsx" },
          { updatedAt: "2026-11-21T10:00:00.000Z" },
        );
        yield* addFileChange(
          "item-2",
          "newer-thread",
          { fileName: "/C:/Users/x/budget.xlsx" },
          { updatedAt: "2026-11-21T12:00:00.000Z" },
        );
        yield* addFileChange(
          "item-3",
          "other-thread",
          { fileName: "/c:/Users/x/budget.xlsx" },
          { updatedAt: "2026-11-21T11:00:00.000Z" },
        );

        const result = yield* service.list({});
        assert.deepEqual(result, {
          entries: [
            {
              path: "C:\\Users\\x\\budget.xlsx",
              fileName: "budget.xlsx",
              itemId: TurnItemId.make("item-2"),
              threadId: ThreadId.make("newer-thread"),
              threadTitle: "newer-thread",
              projectId: ProjectId.make("project"),
              projectTitle: "project",
              workspaceRoot: "C:\\Users\\x",
              mode: "work",
              updatedAt: "2026-11-21T12:00:00.000Z",
            },
            {
              path: "C:\\Users\\x\\budget.xlsx",
              fileName: "budget.xlsx",
              itemId: TurnItemId.make("item-3"),
              threadId: ThreadId.make("other-thread"),
              threadTitle: "other-thread",
              projectId: ProjectId.make("other"),
              projectTitle: "other",
              workspaceRoot: "C:\\Users\\x",
              mode: "code",
              updatedAt: "2026-11-21T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("matches path case-insensitively on Windows and case-sensitively elsewhere", () =>
    Effect.gen(function* () {
      const service = yield* LibraryFiles.LibraryFiles;
      yield* addProject("project", { workspaceRoot: "C:\\Users\\x" });
      yield* addThread("thread", { projectId: "project" });
      yield* addFileChange(
        "item-1",
        "thread",
        { fileName: "C:\\Users\\x\\Report.csv" },
        { updatedAt: "2026-11-21T10:00:00.000Z" },
      );
      yield* addFileChange(
        "item-2",
        "thread",
        { fileName: "/C:/Users/x/report.csv" },
        { updatedAt: "2026-11-21T12:00:00.000Z" },
      );

      const onWindows = yield* service
        .list({})
        .pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.deepEqual(
        onWindows.entries.map((entry) => entry.itemId),
        [TurnItemId.make("item-2")],
      );

      const onLinux = yield* service
        .list({})
        .pipe(Effect.provideService(HostProcess.Platform, "linux"));
      assert.deepEqual(
        onLinux.entries.map((entry) => entry.itemId),
        [TurnItemId.make("item-2"), TurnItemId.make("item-1")],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "drops deleted files, keeps recreated files, and shows only the new path on rename",
    () =>
      Effect.gen(function* () {
        const service = yield* LibraryFiles.LibraryFiles;
        yield* addProject("project", { workspaceRoot: "/workspace" });
        yield* addThread("thread", { projectId: "project" });

        yield* addFileChange(
          "item-1",
          "thread",
          { fileName: "/workspace/removed.md" },
          { updatedAt: "2026-11-21T10:00:00.000Z" },
        );
        yield* addFileChange(
          "item-2",
          "thread",
          {
            fileName: "/workspace/removed.md",
            changes: [{ operation: "delete", path: "/workspace/removed.md" }],
          },
          { updatedAt: "2026-11-21T11:00:00.000Z" },
        );

        yield* addFileChange(
          "item-3",
          "thread",
          { fileName: "/workspace/recreated.md" },
          { updatedAt: "2026-11-21T10:00:00.000Z" },
        );
        yield* addFileChange(
          "item-4",
          "thread",
          {
            fileName: "/workspace/recreated.md",
            changes: [{ operation: "delete", path: "/workspace/recreated.md" }],
          },
          { updatedAt: "2026-11-21T11:00:00.000Z" },
        );
        yield* addFileChange(
          "item-5",
          "thread",
          {
            fileName: "/workspace/recreated.md",
            changes: [{ operation: "add", path: "/workspace/recreated.md" }],
          },
          { updatedAt: "2026-11-21T12:00:00.000Z" },
        );

        yield* addFileChange(
          "item-6",
          "thread",
          { fileName: "/workspace/old-name.md" },
          { updatedAt: "2026-11-21T10:00:00.000Z" },
        );
        yield* addFileChange(
          "item-7",
          "thread",
          {
            fileName: "/workspace/new-name.md",
            changes: [
              {
                operation: "update",
                path: "/workspace/new-name.md",
                oldPath: "/workspace/old-name.md",
              },
            ],
          },
          { updatedAt: "2026-11-21T11:30:00.000Z" },
        );

        const result = yield* service.list({});
        assert.deepEqual(
          result.entries.map((entry) => [entry.path, entry.itemId]),
          [
            ["/workspace/recreated.md", TurnItemId.make("item-5")],
            ["/workspace/new-name.md", TurnItemId.make("item-7")],
          ],
        );
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("expands changes array with multiple files instead of using fileName", () =>
    Effect.gen(function* () {
      const service = yield* LibraryFiles.LibraryFiles;
      yield* addProject("project", { workspaceRoot: "/workspace" });
      yield* addThread("thread", { projectId: "project" });
      yield* addFileChange("item-1", "thread", {
        fileName: "/workspace/ignored-summary.ts",
        changes: [
          { operation: "add", path: "/workspace/first.ts" },
          { operation: "update", path: "/workspace/second.ts" },
        ],
      });

      const result = yield* service.list({});
      assert.deepEqual(
        result.entries.map((entry) => [entry.path, entry.fileName]),
        [
          ["/workspace/first.ts", "first.ts"],
          ["/workspace/second.ts", "second.ts"],
        ],
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("filters by mode, projectIds, deletion state, rollback, and completion status", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* LibraryFiles.LibraryFiles;
      yield* addProject("project", { archived: true, workspaceRoot: "/p1" });
      yield* addProject("other", { workspaceRoot: "/p2" });
      yield* addProject("removed", { deleted: true, workspaceRoot: "/p3" });
      yield* addThread("work-thread", {
        projectId: "project",
        archived: true,
        tags: [WORK_MODE_TAG],
        worktreePath: "/wt/work-thread",
      });
      yield* addThread("code-thread", { projectId: "other", tags: ["Mode:work"] });
      yield* addThread("deleted-thread", { projectId: "project", deleted: true });
      yield* addThread("removed-project-thread", { projectId: "removed" });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('ok-run', 'work-thread', 1, 'codex', 'completed', ${at}, '{}'),
          ('rollback-run', 'work-thread', 2, 'codex', 'rolled_back', ${at}, '{}')
      `;

      yield* addFileChange(
        "item-work",
        "work-thread",
        { fileName: "/wt/work-thread/plan.md" },
        { runId: "ok-run", updatedAt: "2026-11-21T13:00:00.000Z" },
      );
      yield* addFileChange(
        "item-code",
        "code-thread",
        { fileName: "/p2/app.ts" },
        { updatedAt: "2026-11-21T12:00:00.000Z" },
      );
      yield* addFileChange(
        "item-rollback",
        "work-thread",
        { fileName: "/wt/work-thread/rolled-back.md" },
        { runId: "rollback-run" },
      );
      yield* addFileChange("item-deleted-thread", "deleted-thread", {
        fileName: "/p1/deleted-thread.md",
      });
      yield* addFileChange("item-removed-project", "removed-project-thread", {
        fileName: "/p3/removed-project.md",
      });
      yield* addFileChange(
        "item-running",
        "code-thread",
        { fileName: "/p2/running.ts" },
        { status: "running" },
      );

      const all = yield* service.list({});
      assert.deepEqual(
        all.entries.map((entry) => [entry.itemId, entry.mode, entry.workspaceRoot]),
        [
          [TurnItemId.make("item-work"), "work", "/wt/work-thread"],
          [TurnItemId.make("item-code"), "code", "/p2"],
        ],
      );
      assert.deepEqual(
        (yield* service.list({ mode: "work" })).entries.map((entry) => entry.itemId),
        [TurnItemId.make("item-work")],
      );
      assert.deepEqual(
        (yield* service.list({ mode: "code" })).entries.map((entry) => entry.itemId),
        [TurnItemId.make("item-code")],
      );
      assert.deepEqual(
        (yield* service.list({ projectIds: [ProjectId.make("other")] })).entries.map(
          (entry) => entry.itemId,
        ),
        [TurnItemId.make("item-code")],
      );
      assert.deepEqual(
        (yield* service.list({ projectIds: [ProjectId.make("other")], mode: "work" })).entries,
        [],
      );
      assert.deepEqual(yield* service.list({ projectIds: [] }), { entries: [], nextCursor: null });
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("skips files missing on disk and checks existence only for page candidates", () => {
    const checked: Array<string> = [];
    const existing = new Set(["/workspace/a.md", "/workspace/c.md"]);
    return Effect.gen(function* () {
      const service = yield* LibraryFiles.LibraryFiles;
      yield* addProject("project", { workspaceRoot: "/workspace" });
      yield* addThread("thread", { projectId: "project" });
      yield* addFileChange(
        "item-4",
        "thread",
        { fileName: "/workspace/missing.md" },
        { updatedAt: "2026-11-21T14:00:00.000Z" },
      );
      yield* addFileChange(
        "item-3",
        "thread",
        { fileName: "/workspace/a.md" },
        { updatedAt: "2026-11-21T13:00:00.000Z" },
      );
      yield* addFileChange(
        "item-2",
        "thread",
        { fileName: "/workspace/c.md" },
        { updatedAt: "2026-11-21T12:00:00.000Z" },
      );
      yield* addFileChange(
        "item-1",
        "thread",
        { fileName: "/workspace/never-checked.md" },
        { updatedAt: "2026-11-21T11:00:00.000Z" },
      );

      yield* addFileChange(
        "item-5",
        "thread",
        { fileName: NodePath.join(NodeOS.tmpdir(), "scratchpad", "notes.md") },
        { updatedAt: "2026-11-21T15:00:00.000Z" },
      );

      const page = yield* service.list({ limit: 1 });
      assert.deepEqual(
        page.entries.map((entry) => entry.path),
        ["/workspace/a.md"],
      );
      // Temp-folder scratch files are dropped before any existence check.
      assert.deepEqual(checked, ["/workspace/missing.md", "/workspace/a.md"]);
    }).pipe(
      Effect.provide(
        makeTestLayer((path) => {
          checked.push(path);
          return existing.has(path);
        }),
      ),
    );
  });

  it.effect("pages with cursor across ties and sparse candidate batches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* LibraryFiles.LibraryFiles;
      yield* addProject("project", { workspaceRoot: "/workspace" });
      yield* addThread("thread", { projectId: "project" });
      yield* sql`
        WITH RECURSIVE candidates(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM candidates WHERE value < 100
        )
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        SELECT printf('z-%03d', value), 'thread', value, 'file_change', 'completed', ${at}, '{}'
        FROM candidates
      `;
      yield* addFileChange("a-3", "thread", { fileName: "/workspace/three.ts" });
      yield* addFileChange("a-2", "thread", { fileName: "/workspace/three.ts" });
      yield* addFileChange("a-1", "thread", { fileName: "/workspace/two.ts" });
      yield* addFileChange("a-0", "thread", { fileName: "/workspace/one.ts" });

      const page1 = yield* service.list({ limit: 2 });
      assert.deepEqual(page1, {
        entries: [],
        nextCursor: { updatedAt: at, itemId: TurnItemId.make("z-001") },
      });
      const page2 = yield* service.list({ limit: 2, cursor: page1.nextCursor! });
      assert.deepEqual(
        page2.entries.map((entry) => entry.itemId),
        [TurnItemId.make("a-3"), TurnItemId.make("a-1")],
      );
      assert.deepEqual(page2.nextCursor, { updatedAt: at, itemId: TurnItemId.make("a-1") });
      const page3 = yield* service.list({ limit: 2, cursor: page2.nextCursor! });
      assert.deepEqual(
        page3.entries.map((entry) => entry.itemId),
        [TurnItemId.make("a-0")],
      );
      assert.isNull(page3.nextCursor);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("uses the partial index for initial scan and keyset seek without sorting", () =>
    Effect.gen(function* () {
      const service = yield* LibraryFiles.LibraryFiles;
      const sql = yield* SqlClient.SqlClient;
      for (const { input, bindings, access } of [
        { input: {}, bindings: [101], access: "SCAN item" },
        {
          input: {
            projectIds: [ProjectId.make("other")],
            cursor: { updatedAt: at, itemId: TurnItemId.make("item") },
          },
          bindings: ["other", at, "item", 101],
          access: "SEARCH item",
        },
      ]) {
        const trace = traceSqlRouting();
        yield* trace.trace(service.list(input));
        assert.lengthOf(trace.queries, 1);
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${trace.queries[0]!.query}`,
          bindings,
        );
        assert.include(
          plan[0]?.detail,
          `${access} USING INDEX orchestration_v2_projection_turn_items_library_files_idx`,
        );
        assert.notInclude(plan.map((row) => row.detail).join("\n"), "TEMP B-TREE");
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
