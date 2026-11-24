import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresObservabilityProjection } from "../src/observability/postgres-projection.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

describe("observability startup over a historical ledger", () => {
  let database;
  beforeAll(async () => {
    database = await createPostgresTestDatabase("observability_start");
  });
  afterAll(async () => { await database?.close(); });

  it("retains saved cursor and anchor without rereading old events, including zero", async () => {
    for (const cursor of [0, 9182]) {
      const spaceId = database.nextSpaceId();
      await database.pool.query(
        `INSERT INTO runtime_observability_meta (space_id,key,value)
         VALUES ($1,'source_cursor',$2),($1,'source_anchor','saved-anchor')`,
        [spaceId, String(cursor)]
      );
      const runs = {
        projectionPage: async () => [],
        projectionStart: async () => { throw new Error("historical scan"); },
        projectionAnchor: async () => { throw new Error("historical anchor"); }
      };
      const projection = await new PostgresObservabilityProjection({
        pool: database.pool, runs, spaceId
      }).initialize();
      expect(await projection.meta("source_cursor")).toBe(String(cursor));
      expect(await projection.meta("source_anchor")).toBe("saved-anchor");
    }
  });

  it("uses minimum eligible cursor even when event timestamps are out of order", async () => {
    const spaceId = database.nextSpaceId();
    const otherSpace = database.nextSpaceId();
    const run = new PostgresRunStore(database.pool, { spaceId });
    await database.pool.query(
      `INSERT INTO runtime_runs (space_id,id,payload_json,status,updated_at)
       VALUES ($1,'run:test','{}','completed',2000),($2,'run:test','{}','completed',2000)`,
      [spaceId, otherSpace]
    );
    const first = await database.pool.query(
      `INSERT INTO runtime_run_events (space_id,run_id,event_id,sequence,created_at,payload_json)
       VALUES ($1,'run:test','recent-late-time',1,2000,'{}'),
         ($1,'run:test','old',2,100,'{}'),($1,'run:test','recent-early-time',3,1000,'{}'),
         ($2,'run:test','other-space',1,2000,'{}') RETURNING cursor`,
      [spaceId, otherSpace]
    );
    const expected = Number(first.rows[0].cursor) - 1;
    expect(await run.projectionStart(1000)).toBe(expected);
    expect(await run.projectionStart(3000)).toBe(0);
    expect(await database.pool.query("SHOW statement_timeout"))
      .toMatchObject({ rows: [{ statement_timeout: "0" }] });
  });

  it("bounds a blocked initial scan and returns a usable pooled connection", async () => {
    const spaceId = database.nextSpaceId();
    const blocker = await database.pool.connect();
    const target = await database.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE runtime_run_events IN ACCESS EXCLUSIVE MODE");
      const run = new PostgresRunStore({
        query: (...args) => target.query(...args),
        connect: async () => ({ query: (...args) => target.query(...args), release() {} })
      }, { spaceId });
      await expect(run.projectionStart(1000)).rejects.toMatchObject({ code: "57014" });
      expect((await target.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
      expect((await target.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("0");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      target.release();
    }
  }, 8000);
});
