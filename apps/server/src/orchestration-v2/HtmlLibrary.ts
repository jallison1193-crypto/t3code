import {
  type OrchestrationV2ListHtmlLibraryInput,
  type OrchestrationV2ListHtmlLibraryResult,
  ProjectId,
  StoredThreadTags,
  ThreadId,
  TurnItemId,
  WORK_MODE_TAG,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const CANDIDATE_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;

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

export class HtmlLibrary extends Context.Service<
  HtmlLibrary,
  {
    readonly list: (
      input: OrchestrationV2ListHtmlLibraryInput,
    ) => Effect.Effect<OrchestrationV2ListHtmlLibraryResult, SqlError>;
  }
>()("t3/orchestration-v2/HtmlLibrary") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  }: OrchestrationV2ListHtmlLibraryInput) {
    if (projectIds?.length === 0) return { entries: [], nextCursor: null };

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

    const entries: Array<OrchestrationV2ListHtmlLibraryResult["entries"][number]> = [];
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

      const item = Option.getOrUndefined(decodeToolItem(row.payload));
      const reference = item === undefined ? undefined : htmlRenderFromToolItem(item);
      if (reference === undefined || seen.has(reference.attachmentId)) continue;
      const owner = parseThreadSegmentFromAttachmentId(reference.attachmentId);
      if (owner === null || owner !== toSafeThreadAttachmentSegment(row.threadId)) continue;

      seen.add(reference.attachmentId);
      entries.push({
        ...reference,
        updatedAt: row.updatedAt,
        itemId: TurnItemId.make(row.itemId),
        threadId: ThreadId.make(row.threadId),
        threadTitle: row.threadTitle,
        projectId: ProjectId.make(row.projectId),
        projectTitle: row.projectTitle,
        mode: threadMode,
      });
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

  return HtmlLibrary.of({ list });
});

export const layer = Layer.effect(HtmlLibrary, make);
