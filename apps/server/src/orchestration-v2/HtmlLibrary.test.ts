import { ProjectId, ThreadId, TurnItemId, WORK_MODE_TAG } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HtmlLibrary from "./HtmlLibrary.ts";

const layerTest = HtmlLibrary.layer.pipe(
  Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, ServerSettings.layerTest())),
);
const at = "2026-11-21T13:00:00.000Z";

const addProject = Effect.fn("HtmlLibraryTest.addProject")(function* (
  id: string,
  options: { archived?: boolean; deleted?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, archived_at, deleted_at)
    VALUES (${id}, ${id}, ${id}, '[]', ${at}, ${at},
      ${options.archived ? at : null}, ${options.deleted ? at : null})
  `;
});

const addThread = Effect.fn("HtmlLibraryTest.addThread")(function* (
  id: string,
  options: {
    projectId?: string;
    archived?: boolean;
    deleted?: boolean;
    tags?: ReadonlyArray<string>;
    forkedFrom?: string;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({
    tags: options.tags,
    forkedFrom:
      options.forkedFrom === undefined
        ? undefined
        : { type: "run", threadId: options.forkedFrom, runId: "source-run" },
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${id}, ${options.projectId ?? "project"}, ${id}, 'codex', 'full-access', 'default',
      ${at}, ${at}, ${options.archived ? at : null}, ${options.deleted ? at : null}, ${payload})
  `;
});

const addCandidate = Effect.fn("HtmlLibraryTest.addCandidate")(function* (
  id: string,
  thread: string,
  output: unknown,
  options: { toolName?: string; status?: string; runId?: string; inline?: number } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json, inline_work_output)
    VALUES (${id}, ${thread}, ${options.runId ?? null}, 1, 'dynamic_tool', ${options.status ?? "completed"},
      ${at}, ${JSON.stringify({ toolName: options.toolName ?? "html_render", output })},
      ${options.inline ?? 1})
  `;
});

const referenceFor = (thread: string): HtmlRenderReference => ({
  attachmentId: createAttachmentId(thread, "html")!,
  title: "Published page",
  height: 420,
  heights: [[430, 550]],
});

describe("published HTML library", () => {
  it.effect(
    "lists producer-owned HTML from live and archived sources with current physical project and mode filters",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const library = yield* HtmlLibrary.HtmlLibrary;
        const source = referenceFor("Thread:Source");
        const local = referenceFor("fork");
        yield* addProject("project", { archived: true });
        yield* addProject("other");
        yield* addProject("removed", { deleted: true });
        yield* addThread("Thread:Source", { archived: true, tags: [WORK_MODE_TAG] });
        yield* addThread("fork", {
          projectId: "other",
          tags: ["Mode:work"],
          forkedFrom: "Thread:Source",
        });
        yield* addThread("deleted", { deleted: true });
        yield* addThread("removed-project", { projectId: "removed" });
        yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('source-run', 'Thread:Source', 1, 'codex', 'completed', ${at}, '{}'),
          ('rollback', 'Thread:Source', 2, 'codex', 'rolled_back', ${at}, '{}')
      `;
        yield* addCandidate(
          "z-source",
          "Thread:Source",
          { htmlRender: source, html: "<html>body</html>" },
          {
            runId: "source-run",
          },
        );
        yield* addCandidate(
          "y-fork",
          "fork",
          [{ type: "text", text: JSON.stringify({ htmlRender: local }) }],
          { toolName: "mcp__t3-code__html_render" },
        );
        yield* addCandidate("x-foreign", "fork", { htmlRender: source });
        yield* addCandidate(
          "w-rollback",
          "Thread:Source",
          { htmlRender: referenceFor("Thread:Source") },
          {
            runId: "rollback",
          },
        );
        yield* addCandidate("v-deleted", "deleted", { htmlRender: referenceFor("deleted") });
        yield* addCandidate("u-removed", "removed-project", {
          htmlRender: referenceFor("removed-project"),
        });
        yield* addCandidate("t-error", "fork", {
          is_error: true,
          structuredContent: { htmlRender: local },
        });
        yield* addCandidate(
          "s-wrong-tool",
          "fork",
          { htmlRender: local },
          { toolName: "other.html_render" },
        );
        yield* addCandidate("r-pending", "fork", { htmlRender: local }, { status: "running" });
        yield* addCandidate("q-flag-off", "fork", { htmlRender: local }, { inline: 0 });
        yield* addCandidate("p-invalid-id", "fork", {
          htmlRender: { ...local, attachmentId: "fork-invalid" },
        });

        const all = yield* library.list({});
        assert.deepEqual(all, {
          entries: [
            {
              ...source,
              pinned: false,
              itemId: TurnItemId.make("z-source"),
              threadId: ThreadId.make("Thread:Source"),
              threadTitle: "Thread:Source",
              projectId: ProjectId.make("project"),
              projectTitle: "project",
              updatedAt: at,
              mode: "work",
            },
            {
              ...local,
              pinned: false,
              itemId: TurnItemId.make("y-fork"),
              threadId: ThreadId.make("fork"),
              threadTitle: "fork",
              projectId: ProjectId.make("other"),
              projectTitle: "other",
              updatedAt: at,
              mode: "code",
            },
          ],
          nextCursor: null,
        });
        assert.deepEqual((yield* library.list({ mode: "work" })).entries, all.entries.slice(0, 1));
        assert.deepEqual((yield* library.list({ mode: "code" })).entries, all.entries.slice(1));
        assert.deepEqual(
          (yield* library.list({ projectIds: [ProjectId.make("other")] })).entries,
          all.entries.slice(1),
        );
        assert.deepEqual(
          (yield* library.list({ projectIds: [ProjectId.make("other")], mode: "work" })).entries,
          [],
        );
        assert.deepEqual(
          (yield* library.list({
            projectIds: [ProjectId.make("other"), ProjectId.make("project")],
          })).entries,
          all.entries,
        );
        assert.deepEqual(yield* library.list({ projectIds: [] }), {
          entries: [],
          nextCursor: null,
        });
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"tags":["mode:work"]}'
        WHERE thread_id = 'fork'`;
        assert.deepEqual(
          (yield* library.list({ mode: "work" })).entries.map((entry) => entry.itemId),
          ["z-source", "y-fork"],
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "advances over ties, skipped candidates and duplicate references without omitting the next result",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const library = yield* HtmlLibrary.HtmlLibrary;
        yield* addProject("project");
        yield* addThread("source");
        yield* sql`
        WITH RECURSIVE candidates(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM candidates WHERE value < 100
        )
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json, inline_work_output)
        SELECT printf('z-%03d', value), 'source', value, 'dynamic_tool', 'completed', ${at}, '{}', 1
        FROM candidates
      `;
        const first = referenceFor("source");
        yield* addCandidate("a-3", "source", { htmlRender: first });
        yield* addCandidate("a-2", "source", { htmlRender: first });
        yield* addCandidate("a-1", "source", { htmlRender: referenceFor("source") });
        yield* addCandidate(
          "a-0",
          "source",
          { structuredContent: { htmlRender: referenceFor("source") } },
          { toolName: "execute" },
        );

        const page = yield* library.list({ limit: 2 });
        assert.deepEqual(page, {
          entries: [],
          nextCursor: { updatedAt: at, itemId: TurnItemId.make("z-001") },
        });
        assert.isNotNull(page.nextCursor);
        const next = yield* library.list({ limit: 2, cursor: page.nextCursor! });
        assert.deepEqual(
          next.entries.map((entry) => entry.itemId),
          ["a-3", "a-1"],
        );
        assert.deepEqual(next.nextCursor, { updatedAt: at, itemId: TurnItemId.make("a-1") });
        const last = yield* library.list({ limit: 2, cursor: next.nextCursor! });
        assert.deepEqual(
          last.entries.map((entry) => entry.itemId),
          ["a-0"],
        );
        assert.isNull(last.nextCursor);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("uses the partial index for the initial scan and keyset seek without sorting", () =>
    Effect.gen(function* () {
      const library = yield* HtmlLibrary.HtmlLibrary;
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
        yield* trace.trace(library.list(input));
        assert.lengthOf(trace.queries, 1);
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${trace.queries[0]!.query}`,
          bindings,
        );
        assert.include(
          plan[0]?.detail,
          `${access} USING INDEX orchestration_v2_projection_turn_items_html_library_idx`,
        );
        assert.notInclude(plan.map((row) => row.detail).join("\n"), "TEMP B-TREE");
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "applies title overrides and pin flags, and looks up pinned live entries in pin order by primary key",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const library = yield* HtmlLibrary.HtmlLibrary;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* addProject("project");
        yield* addProject("other");
        yield* addThread("work-thread", { projectId: "project", tags: [WORK_MODE_TAG] });
        yield* addThread("code-thread", { projectId: "other" });
        yield* addThread("deleted-thread", { projectId: "project", deleted: true });
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES ('rolled-back', 'work-thread', 1, 'codex', 'rolled_back', ${at}, '{}')
        `;
        const olderPin = referenceFor("work-thread");
        const newerPin = referenceFor("code-thread");
        const renamedOnly = referenceFor("code-thread");
        const deletedRef = referenceFor("deleted-thread");
        const rolledBackRef = referenceFor("work-thread");
        yield* addCandidate("item-older", "work-thread", { htmlRender: olderPin });
        yield* addCandidate("item-newer", "code-thread", { htmlRender: newerPin });
        yield* addCandidate("item-renamed", "code-thread", { htmlRender: renamedOnly });
        yield* addCandidate("item-deleted", "deleted-thread", { htmlRender: deletedRef });
        yield* addCandidate(
          "item-rollback",
          "work-thread",
          { htmlRender: rolledBackRef },
          { runId: "rolled-back" },
        );

        yield* settings.updateSettings({
          htmlLibraryEntries: {
            [olderPin.attachmentId]: {
              threadId: ThreadId.make("work-thread"),
              itemId: TurnItemId.make("item-older"),
              title: "Custom work title",
              pinnedAt: "2026-11-22T01:00:00.000Z",
            },
            [newerPin.attachmentId]: {
              threadId: ThreadId.make("code-thread"),
              itemId: TurnItemId.make("item-newer"),
              pinnedAt: "2026-11-22T02:00:00.000Z",
            },
            [renamedOnly.attachmentId]: {
              threadId: ThreadId.make("code-thread"),
              itemId: TurnItemId.make("item-renamed"),
              title: "Renamed only",
            },
            [deletedRef.attachmentId]: {
              threadId: ThreadId.make("deleted-thread"),
              itemId: TurnItemId.make("item-deleted"),
              pinnedAt: "2026-11-22T03:00:00.000Z",
            },
            [rolledBackRef.attachmentId]: {
              threadId: ThreadId.make("work-thread"),
              itemId: TurnItemId.make("item-rollback"),
              pinnedAt: "2026-11-22T04:00:00.000Z",
            },
          },
        });

        const all = yield* library.list({});
        assert.deepEqual(
          all.entries.map((entry) => ({
            itemId: entry.itemId,
            title: entry.title,
            pinned: entry.pinned,
            pinnedAt: entry.pinnedAt,
          })),
          [
            {
              itemId: TurnItemId.make("item-renamed"),
              title: "Renamed only",
              pinned: false,
              pinnedAt: undefined,
            },
            {
              itemId: TurnItemId.make("item-older"),
              title: "Custom work title",
              pinned: true,
              pinnedAt: "2026-11-22T01:00:00.000Z",
            },
            {
              itemId: TurnItemId.make("item-newer"),
              title: "Published page",
              pinned: true,
              pinnedAt: "2026-11-22T02:00:00.000Z",
            },
          ],
        );

        const trace = traceSqlRouting();
        const pinnedAll = yield* trace.trace(library.list({ pinned: true }));
        assert.isNull(pinnedAll.nextCursor);
        assert.deepEqual(
          pinnedAll.entries.map((entry) => ({
            itemId: entry.itemId,
            title: entry.title,
            pinned: entry.pinned,
            pinnedAt: entry.pinnedAt,
          })),
          [
            {
              itemId: TurnItemId.make("item-newer"),
              title: "Published page",
              pinned: true,
              pinnedAt: "2026-11-22T02:00:00.000Z",
            },
            {
              itemId: TurnItemId.make("item-older"),
              title: "Custom work title",
              pinned: true,
              pinnedAt: "2026-11-22T01:00:00.000Z",
            },
          ],
        );
        assert.lengthOf(trace.queries, 1);
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${trace.queries[0]!.query}`,
          ["item-older", "item-newer", "item-deleted", "item-rollback"],
        );
        assert.include(plan[0]?.detail, "SEARCH item USING INDEX");
        assert.notInclude(
          plan[0]?.detail,
          "orchestration_v2_projection_turn_items_html_library_idx",
        );

        const pinnedWork = yield* library.list({ pinned: true, mode: "work" });
        assert.deepEqual(
          pinnedWork.entries.map((entry) => entry.itemId),
          [TurnItemId.make("item-older")],
        );
        const pinnedOther = yield* library.list({
          pinned: true,
          projectIds: [ProjectId.make("other")],
        });
        assert.deepEqual(
          pinnedOther.entries.map((entry) => entry.itemId),
          [TurnItemId.make("item-newer")],
        );
      }).pipe(Effect.provide(layerTest)),
  );
});
