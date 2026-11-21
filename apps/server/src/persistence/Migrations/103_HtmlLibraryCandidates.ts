import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_html_library_idx
    ON orchestration_v2_projection_turn_items(updated_at DESC, turn_item_id DESC)
    WHERE type = 'dynamic_tool' AND status = 'completed' AND inline_work_output = 1
  `;
});
