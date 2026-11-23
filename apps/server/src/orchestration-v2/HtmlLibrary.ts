import {
  type HtmlLibraryEntryOverride,
  type OrchestrationV2ListHtmlLibraryInput,
  type OrchestrationV2ListHtmlLibraryResult,
  ProjectId,
  type ServerSettingsError,
  type SidebarModeFilter,
  StoredThreadTags,
  ThreadId,
  TurnItemId,
  WORK_MODE_TAG,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  htmlLibraryEntryOverrideChange,
  isValidLibraryEntryTitle,
} from "@t3tools/shared/serverSettings";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerSettings from "../serverSettings.ts";

const CANDIDATE_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_BATCHES = 10;
const PINNED_LOOKUP_BATCH_SIZE = 500;

export class HtmlLibraryEntryNotFoundError extends Schema.TaggedError<HtmlLibraryEntryNotFoundError>()(
  "HtmlLibraryEntryNotFoundError",
  {
    threadId: ThreadId,
    itemId: TurnItemId,
  },
) {
  override get message(): string {
    return "The HTML Library page was not found.";
  }
}

export class HtmlLibraryInvalidTitleError extends Schema.TaggedError<HtmlLibraryInvalidTitleError>()(
  "HtmlLibraryInvalidTitleError",
  {},
) {
  override get message(): string {
    return "Page title must be a single line.";
  }
}

const decodeToolItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      toolName: Schema.String,
      output: Schema.optionalKey(Schema.Unknown),
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
  readonly tags: string | null;
  readonly payload: string | null;
}

type LibraryEntry = OrchestrationV2ListHtmlLibraryResult["entries"][number];

function compareStrings(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toLibraryEntry(
  row: Candidate,
  mode: SidebarModeFilter,
  seen: Set<string>,
  overrides: Readonly<Record<string, HtmlLibraryEntryOverride>>,
): LibraryEntry | null {
  if (
    row.payload === null ||
    row.threadTitle === null ||
    row.projectId === null ||
    row.projectTitle === null
  ) {
    return null;
  }
  const tags = Option.getOrUndefined(decodeTags(row.tags));
  const threadMode = tags?.includes(WORK_MODE_TAG) ? "work" : "code";
  if (mode !== "all" && mode !== threadMode) return null;

  const item = Option.getOrUndefined(decodeToolItem(row.payload));
  const reference = item === undefined ? undefined : htmlRenderFromToolItem(item);
  if (reference === undefined || seen.has(reference.attachmentId)) return null;
  const owner = parseThreadSegmentFromAttachmentId(reference.attachmentId);
  if (owner === null || owner !== toSafeThreadAttachmentSegment(row.threadId)) return null;

  seen.add(reference.attachmentId);
  const override = Object.hasOwn(overrides, reference.attachmentId)
    ? overrides[reference.attachmentId]
    : undefined;
  const pinnedAt = override?.pinnedAt;
  return {
    ...reference,
    ...(override?.title === undefined ? {} : { title: override.title }),
    pinned: pinnedAt !== undefined,
    ...(pinnedAt === undefined ? {} : { pinnedAt }),
    updatedAt: row.updatedAt,
    itemId: TurnItemId.make(row.itemId),
    threadId: ThreadId.make(row.threadId),
    threadTitle: row.threadTitle,
    projectId: ProjectId.make(row.projectId),
    projectTitle: row.projectTitle,
    mode: threadMode,
  };
}

export class HtmlLibrary extends Context.Service<
  HtmlLibrary,
  {
    readonly list: (
      input: OrchestrationV2ListHtmlLibraryInput,
    ) => Effect.Effect<OrchestrationV2ListHtmlLibraryResult, SqlError | ServerSettingsError>;
    readonly read: (input: {
      readonly projectId?: ProjectId | undefined;
      readonly pinned?: boolean | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<
      {
        readonly entries: ReadonlyArray<LibraryEntry>;
        readonly hasMore: boolean;
      },
      SqlError | ServerSettingsError
    >;
    readonly updateEntry: (input: {
      readonly action: "pin" | "unpin" | "rename";
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly title?: string | undefined;
    }) => Effect.Effect<
      LibraryEntry,
      SqlError | ServerSettingsError | HtmlLibraryEntryNotFoundError | HtmlLibraryInvalidTitleError
    >;
  }
>()("t3/orchestration-v2/HtmlLibrary") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const updateSemaphore = yield* Semaphore.make(1);
  // Fork-only index: a numbered migration would collide with upstream's next migration id.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_html_library_idx
    ON orchestration_v2_projection_turn_items(updated_at DESC, turn_item_id DESC)
    WHERE type = 'dynamic_tool' AND status = 'completed' AND inline_work_output = 1
  `;

  const list = Effect.fn("HtmlLibrary.list")(function* ({
    projectIds,
    mode = "all",
    limit = DEFAULT_PAGE_SIZE,
    cursor,
    pinned,
  }: OrchestrationV2ListHtmlLibraryInput) {
    if (projectIds?.length === 0) return { entries: [], nextCursor: null };
    const { htmlLibraryEntries } = yield* serverSettings.getSettings;

    if (pinned) {
      const itemIds = [
        ...new Set(
          Object.values(htmlLibraryEntries).flatMap((entry) =>
            entry.pinnedAt === undefined ? [] : [entry.itemId],
          ),
        ),
      ];
      if (itemIds.length === 0) return { entries: [], nextCursor: null };

      const entries: Array<LibraryEntry> = [];
      const seen = new Set<string>();
      for (let start = 0; start < itemIds.length; start += PINNED_LOOKUP_BATCH_SIZE) {
        const batch = itemIds.slice(start, start + PINNED_LOOKUP_BATCH_SIZE);
        const rows = yield* sql<Candidate>`
          SELECT
            item.turn_item_id AS itemId, item.updated_at AS updatedAt, item.thread_id AS threadId,
            thread.title AS threadTitle, project.project_id AS projectId, project.title AS projectTitle,
            CASE WHEN json_valid(thread.payload_json) THEN thread.payload_json -> '$.tags' END AS tags,
            CASE WHEN thread.deleted_at IS NULL AND project.deleted_at IS NULL
              AND project.project_id IS NOT NULL AND run.status IS NOT 'rolled_back'
              ${projectIds === undefined ? sql`` : sql`AND project.project_id IN ${sql.in(projectIds)}`}
              THEN item.payload_json END AS payload
          FROM orchestration_v2_projection_turn_items AS item
          LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
          LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
          WHERE item.turn_item_id IN ${sql.in(batch)}
            AND item.type = 'dynamic_tool' AND item.status = 'completed' AND item.inline_work_output = 1
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of rows) {
          const entry = toLibraryEntry(row, mode, seen, htmlLibraryEntries);
          if (entry?.pinned) entries.push(entry);
        }
      }
      entries.sort(
        (a, b) =>
          compareStrings(b.pinnedAt ?? "", a.pinnedAt ?? "") ||
          compareStrings(b.updatedAt, a.updatedAt) ||
          compareStrings(b.itemId, a.itemId),
      );
      return { entries, nextCursor: null };
    }

    // Filter in the SELECT so even a sparse project or mode examines a bounded batch.
    const rows = yield* sql<Candidate>`
      SELECT
        item.turn_item_id AS itemId, item.updated_at AS updatedAt, item.thread_id AS threadId,
        thread.title AS threadTitle, project.project_id AS projectId, project.title AS projectTitle,
        CASE WHEN json_valid(thread.payload_json) THEN thread.payload_json -> '$.tags' END AS tags,
        CASE WHEN thread.deleted_at IS NULL AND project.deleted_at IS NULL
          AND project.project_id IS NOT NULL AND run.status IS NOT 'rolled_back'
          ${projectIds === undefined ? sql`` : sql`AND project.project_id IN ${sql.in(projectIds)}`}
          THEN item.payload_json END AS payload
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
      LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
      WHERE item.type = 'dynamic_tool' AND item.status = 'completed' AND item.inline_work_output = 1
        ${
          cursor === undefined
            ? sql``
            : sql`AND (item.updated_at, item.turn_item_id) < (${cursor.updatedAt}, ${cursor.itemId})`
        }
      ORDER BY item.updated_at DESC, item.turn_item_id DESC
      LIMIT ${CANDIDATE_LIMIT + 1}
    `.pipe(NodeSqliteClient.readOnly);

    const entries: Array<LibraryEntry> = [];
    const seen = new Set<string>();
    let examined = 0;
    for (const row of rows.slice(0, CANDIDATE_LIMIT)) {
      examined++;
      const entry = toLibraryEntry(row, mode, seen, htmlLibraryEntries);
      if (entry === null) continue;
      entries.push(entry);
      if (entries.length === limit) break;
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

  const read = Effect.fn("HtmlLibrary.read")(function* (input: {
    readonly projectId?: ProjectId | undefined;
    readonly pinned?: boolean | undefined;
    readonly limit?: number | undefined;
  }) {
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const projectFilter = input.projectId === undefined ? {} : { projectIds: [input.projectId] };
    if (input.pinned === true) {
      const result = yield* list({ ...projectFilter, pinned: true });
      return {
        entries: result.entries.slice(0, limit),
        hasMore: result.entries.length > limit,
      };
    }
    const entries: Array<LibraryEntry> = [];
    const seen = new Set<string>();
    let cursor: OrchestrationV2ListHtmlLibraryInput["cursor"];
    let hasMore = false;
    for (let batch = 0; batch < MAX_READ_BATCHES && entries.length < limit; batch++) {
      const page = yield* list({
        ...projectFilter,
        limit: limit - entries.length,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.entries) {
        if (seen.has(entry.attachmentId)) continue;
        seen.add(entry.attachmentId);
        entries.push(entry);
        if (entries.length === limit) break;
      }
      hasMore = page.nextCursor !== null;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { entries, hasMore };
  });

  const updateEntry = Effect.fn("HtmlLibrary.updateEntry")(function* (input: {
    readonly action: "pin" | "unpin" | "rename";
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly title?: string | undefined;
  }) {
    if (
      input.action === "rename" &&
      input.title !== undefined &&
      !isValidLibraryEntryTitle(input.title)
    ) {
      return yield* new HtmlLibraryInvalidTitleError();
    }
    return yield* updateSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* sql<Candidate>`
          SELECT
            item.turn_item_id AS itemId, item.updated_at AS updatedAt, item.thread_id AS threadId,
            thread.title AS threadTitle, project.project_id AS projectId, project.title AS projectTitle,
            CASE WHEN json_valid(thread.payload_json) THEN thread.payload_json -> '$.tags' END AS tags,
            CASE WHEN thread.deleted_at IS NULL AND project.deleted_at IS NULL
              AND project.project_id IS NOT NULL AND run.status IS NOT 'rolled_back'
              THEN item.payload_json END AS payload
          FROM orchestration_v2_projection_turn_items AS item
          LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
          LEFT JOIN projection_projects AS project ON project.project_id = thread.project_id
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
          WHERE item.turn_item_id = ${input.itemId}
            AND item.thread_id = ${input.threadId}
            AND item.type = 'dynamic_tool' AND item.status = 'completed' AND item.inline_work_output = 1
          LIMIT 1
        `.pipe(NodeSqliteClient.readOnly);
        const row = rows[0];
        const { htmlLibraryEntries } = yield* serverSettings.getSettings;
        const current =
          row === undefined ? null : toLibraryEntry(row, "all", new Set(), htmlLibraryEntries);
        if (row === undefined || current === null) {
          return yield* new HtmlLibraryEntryNotFoundError({
            threadId: input.threadId,
            itemId: input.itemId,
          });
        }
        const stored = Object.hasOwn(htmlLibraryEntries, current.attachmentId)
          ? htmlLibraryEntries[current.attachmentId]
          : undefined;
        const change =
          input.action === "pin"
            ? { kind: "pin" as const, pinnedAt: DateTime.formatIso(yield* DateTime.now) }
            : input.action === "unpin"
              ? { kind: "unpin" as const }
              : { kind: "rename" as const, title: input.title ?? null };
        const nextOverride = htmlLibraryEntryOverrideChange(current, stored, change);
        const nextSettings = yield* serverSettings.updateSettings({
          htmlLibraryEntries: { [current.attachmentId]: nextOverride },
        });
        const updated = toLibraryEntry(row, "all", new Set(), nextSettings.htmlLibraryEntries);
        if (updated === null) {
          return yield* new HtmlLibraryEntryNotFoundError({
            threadId: input.threadId,
            itemId: input.itemId,
          });
        }
        return updated;
      }),
    );
  });

  return HtmlLibrary.of({ list, read, updateEntry });
});

export const layer = Layer.effect(HtmlLibrary, make);
