import { describe, expect, it } from "vitest";
import {
  postgresObservabilitySql,
  validatePostgresObservabilitySql
} from "../src/observability/postgres-projection.mjs";

describe("PostgreSQL observability query boundary", () => {
  it("converts only positional question-mark parameters", () => {
    const converted = postgresObservabilitySql(
      "SELECT '?' AS literal, run_id FROM obs_runs "
      + "WHERE status = ? AND identity = 'it''s ?' -- ?\n"
      + "AND duration_ms > ?"
    );
    expect(converted).toEqual({
      sql: "SELECT '?' AS literal, run_id FROM obs_runs "
        + "WHERE status = $1 AND identity = 'it''s ?' -- ?\n"
        + "AND duration_ms > $2",
      parameters: 2
    });
  });

  it.each([
    "DELETE FROM obs_runs",
    "SELECT * FROM account_users",
    "SELECT * FROM runtime_runs",
    "SELECT * FROM pg_catalog.pg_roles",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM obs_runs; SELECT * FROM obs_events",
    "SELECT * FROM obs_runs WHERE status = $1"
  ])("rejects SQL outside the sanitized read model: %s", (sql) => {
    expect(() => validatePostgresObservabilitySql(sql)).toThrow();
  });

  it("accepts bounded analytical SELECT and CTE queries", () => {
    expect(() => validatePostgresObservabilitySql(
      "SELECT status, COUNT(*) AS count FROM obs_runs GROUP BY status"
    )).not.toThrow();
    expect(() => validatePostgresObservabilitySql(
      "WITH failed AS (SELECT * FROM obs_events WHERE ok = 0) "
      + "SELECT tool, COUNT(*) FROM failed GROUP BY tool"
    )).not.toThrow();
  });
});
