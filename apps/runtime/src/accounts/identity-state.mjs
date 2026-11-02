import { exportJWK, generateKeyPair, importJWK } from "jose";

// Shared across restarts; values contain credentials and are never returned
// through account APIs.
export async function createIdentityState(database) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS local_identity_state (
      namespace TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL,
      expires_at BIGINT NOT NULL, PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS local_identity_state_expiry ON local_identity_state(expires_at);
  `);
  const store = (namespace) => ({
    async get(key) {
      return (await database.query(
        `SELECT value FROM local_identity_state
         WHERE namespace = $1 AND key = $2 AND expires_at > $3`,
        [namespace, key, Date.now()]
      )).rows[0]?.value;
    },
    async set(key, value) {
      await database.query(
        `INSERT INTO local_identity_state VALUES ($1, $2, $3, $4)
         ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [namespace, key, JSON.stringify(value), value.expiresAt]
      );
    },
    async delete(key) {
      await database.query("DELETE FROM local_identity_state WHERE namespace = $1 AND key = $2", [namespace, key]);
    },
    async take(key) {
      return (await database.query(
        `DELETE FROM local_identity_state WHERE namespace = $1 AND key = $2 AND expires_at > $3 RETURNING value`,
        [namespace, key, Date.now()]
      )).rows[0]?.value;
    },
    async values() {
      return (await database.query(
        "SELECT value FROM local_identity_state WHERE namespace = $1 AND expires_at > $2",
        [namespace, Date.now()]
      )).rows.map(row => row.value);
    }
  });
  const keys = store("signing");
  let jwk = await keys.get("rs256");
  if (!jwk) {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const candidate = { ...await exportJWK(privateKey), kid: "zion-local", use: "sig", alg: "RS256", expiresAt: 8640000000000000 };
    await database.query(
      "INSERT INTO local_identity_state VALUES ('signing', 'rs256', $1, $2) ON CONFLICT DO NOTHING",
      [JSON.stringify(candidate), candidate.expiresAt]
    );
    jwk = await keys.get("rs256");
  }
  const privateKey = await importJWK(jwk, "RS256");
  const { kty, n, e, kid, use, alg } = jwk;
  return { store, privateKey, publicJwk: { kty, n, e, kid, use, alg } };
}
