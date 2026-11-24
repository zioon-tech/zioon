import { expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { archiveHistoricalEvents } from "../src/run-event-archives.mjs";

it("probes one event per candidate Run even with stale pending-index estimates", async () => {
  const db = await createPostgresTestDatabase("archive_candidate");
  try {
    // Model the initial migration: statistics were gathered while the partial
    // index was empty, then legacy events became pending without fresh stats.
    await db.pool.query("ANALYZE runtime_run_events");
    const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
    await store.create({ id: "history", attemptId: "a", status: "completed", updatedAt: 1 });
    await db.pool.query(`INSERT INTO runtime_run_events
      (space_id,run_id,event_id,sequence,created_at,payload_json)
      SELECT $1,'history','e-'||n,n,n,jsonb_build_object(
        'runId','history','eventId','e-'||n,'sequence',n,'timestamp',n,
        'type','message.delta','data',jsonb_build_object('delta','中文'))
      FROM generate_series(1,16384) n`, [store.spaceId]);
    const plans = [];
    await store.transaction(async client => {
      await client.query("SET LOCAL statement_timeout='2000ms'");
      const traced = {
        async query(sql, args) {
          if (sql.startsWith("SELECT r.space_id")) {
            const result = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, args);
            plans.push(result.rows[0]["QUERY PLAN"][0]);
          }
          return client.query(sql, args);
        }
      };
      const result = await archiveHistoricalEvents(traced, { cutoff: 100, maxRows: 16 });
      expect(result.rewrittenRows).toBe(16);
      expect(result.cursor).toEqual({ spaceId: store.spaceId, runId: "history" });
    });
    expect(plans).toHaveLength(2); // candidate selection and the rechecked row lock
    for (const plan of plans) {
      const scans = [];
      function walk(node, ancestors = []) {
        if (node["Relation Name"] === "runtime_run_events") scans.push({ node, ancestors });
        for (const child of node.Plans || []) walk(child, [...ancestors, node]);
      }
      walk(plan.Plan);
      expect(scans).toHaveLength(1);
      const { node, ancestors } = scans[0];
      expect(node["Actual Rows"]).toBeLessThanOrEqual(1);
      expect(node["Index Cond"]).toContain("space_id = r.space_id");
      expect(node["Index Cond"]).toContain("run_id = r.id");
      // PostgreSQL may wrap the lateral probe in a Subquery Scan. Require its
      // own limit rather than relying on that wrapper's parent relationship.
      expect(ancestors.some(parent => parent !== plan.Plan
        && parent["Node Type"] === "Limit" && parent["Plan Rows"] === 1)).toBe(true);
    }
    expect(await store.getEvent("history", 1)).toEqual({
      runId: "history", eventId: "e-1", sequence: 1, timestamp: 1,
      type: "message.delta", data: { delta: "中文" }
    });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_run_events")).rows[0].n).toBe(16384);
  } finally {
    await db.close();
  }
}, 15000);
