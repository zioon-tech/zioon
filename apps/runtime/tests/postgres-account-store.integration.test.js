import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAccountStore } from "../src/accounts/postgres-account-store.mjs";

const { Pool } = pg;
const connectionString = process.env.ZION_TEST_POSTGRES_URL || "";
const suite = connectionString ? describe : describe.skip;
const schema = `zion_account_test_${randomBytes(8).toString("hex")}`;
const policy = {
  preset: "workspace-write",
  allowedTools: ["read"],
  maxToolCalls: 5,
  fileRoots: [],
  allowedCommandPrefixes: [],
  allowedTerminalSessionIds: [],
  allowedRecipients: [],
  maxMailPerRun: 0
};

suite("PostgresAccountStore", () => {
  let admin;
  let pool;
  let store;

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString,
      max: 4,
      options: `-c search_path=${schema}`
    });
    store = await new PostgresAccountStore({ pool }).initialize();
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("provisions isolated personal Spaces and switches an authenticated session to a team", async () => {
    const alice = await store.resolveIdentity({
      issuer: "https://identity.test",
      subject: "alice",
      name: "Alice",
      email: "alice@example.test",
      emailVerified: true
    });
    const bob = await store.resolveIdentity({
      issuer: "https://identity.test",
      subject: "bob",
      name: "Bob",
      email: "bob@example.test",
      emailVerified: true
    });
    const [alicePersonal] = await store.listSpaces(alice.id);
    const [bobPersonal] = await store.listSpaces(bob.id);
    expect(alicePersonal).toMatchObject({ kind: "personal", membership: { role: "owner" } });
    expect(bobPersonal).toMatchObject({ kind: "personal", membership: { role: "owner" } });
    expect(alicePersonal.id).not.toBe(bobPersonal.id);

    const login = await store.createSession(bob.id);
    expect((await store.authenticate(login.token)).space.id).toBe(bobPersonal.id);

    const team = await store.createTeamSpace(alice.id, { name: "Research" });
    const invitation = await store.invite(alice.id, { role: "member" }, team.id);
    const accepted = await store.acceptInvitation(bob.id, invitation.token);
    expect(accepted.membership).toMatchObject({ spaceId: team.id, role: "member" });
    await store.selectSpace(bob.id, login.sessionId, team.id);
    expect((await store.authenticate(login.token)).space.id).toBe(team.id);

    const principal = await store.issueGrant(bob.id, policy, { spaceId: team.id });
    expect((await store.validateGrant(principal)).policy.allowedTools).toEqual(["read"]);
    await store.setMember(alice.id, bob.id, { role: "member", status: "removed" }, team.id);
    await expect(store.validateGrant(principal)).rejects.toThrow("grant_inactive");
    expect((await store.authenticate(login.token)).space.id).toBe(bobPersonal.id);
  });

  it("allows durable task grants without extending interactive Run grants", async () => {
    const owner = await store.resolveIdentity({
      issuer: "https://identity.test",
      subject: "durable-task-owner",
      name: "Durable Task Owner"
    });
    const [space] = await store.listSpaces(owner.id);
    const ttlMs = 365 * 86_400_000;

    const taskPrincipal = await store.issueGrant(owner.id, policy, {
      spaceId: space.id,
      purpose: "task",
      sourceId: "scheduler:test",
      ttlMs
    });
    expect((await store.validateGrant(taskPrincipal)).principal.kind).toBe("service");
    await expect(store.issueGrant(owner.id, policy, {
      spaceId: space.id,
      purpose: "run",
      ttlMs
    })).rejects.toThrow("invalid_grant_lifetime");
  });

  it("allows imported audit cursors to overlap across Spaces", async () => {
    const first = await store.resolveIdentity({
      issuer: "https://identity.test",
      subject: "audit-first",
      name: "Audit First",
      email: "audit-first@example.test",
      emailVerified: true
    });
    const second = await store.resolveIdentity({
      issuer: "https://identity.test",
      subject: "audit-second",
      name: "Audit Second",
      email: "audit-second@example.test",
      emailVerified: true
    });
    const [firstSpace] = await store.listSpaces(first.id);
    const [secondSpace] = await store.listSpaces(second.id);
    const sequence = 424242;
    for (const [space, actor] of [
      [firstSpace, first],
      [secondSpace, second]
    ]) {
      await pool.query(
        `INSERT INTO account_audit
         (sequence, space_id, actor_id, action, target_id, created_at, details_json)
         VALUES ($1, $2, $3, 'migration.test', $2, $4, '{}'::jsonb)`,
        [sequence, space.id, actor.id, Date.now()]
      );
    }
    const result = await pool.query(
      "SELECT space_id FROM account_audit WHERE sequence = $1 ORDER BY space_id",
      [sequence]
    );
    expect(result.rows.map((row) => row.space_id)).toEqual(
      [firstSpace.id, secondSpace.id].sort()
    );
    expect((await pool.query(
      "SELECT 1 FROM account_schema_migrations WHERE version = 2"
    )).rowCount).toBe(1);
  });
});
