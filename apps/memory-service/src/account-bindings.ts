import { createHash } from "node:crypto";
import { core } from "./upstream.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const error = (code, statusCode = 409) => Object.assign(new Error(code), { statusCode });
export function createAccountBindings(db, accountIssuer) {
  const sql = db.$client;
  sql.exec(`CREATE TABLE IF NOT EXISTS zioon_memory_account_links (
    subject TEXT PRIMARY KEY, legacy_scope TEXT UNIQUE NOT NULL,
    memory_user_id TEXT UNIQUE NOT NULL REFERENCES users(id), linked_at INTEGER NOT NULL
  )`);
  const legacy = (value) => JSON.stringify([value.space.id, value.user.id]);
  const canonical = (value) => value.accountIdentity?.issuer === accountIssuer
    ? value.accountIdentity.subject : null;
  function resolve(value) {
    const subject = canonical(value);
    const oldScope = legacy(value);
    const linked = subject
      ? sql.query("SELECT * FROM zioon_memory_account_links WHERE subject=?").get(subject)
      : sql.query("SELECT * FROM zioon_memory_account_links WHERE legacy_scope=?").get(oldScope);
    return linked
      ? { scope: linked.legacy_scope, subject: linked.subject }
      : { scope: subject ? JSON.stringify(["adc", subject]) : oldScope, subject };
  }
  return {
    resolve,
    // Both credentials are verified remotely before this immutable transaction.
    // No account is ever linked based on matching emails or display names.
    link(adc, runtime) {
      const subject = canonical(adc);
      if (!subject || canonical(runtime) && canonical(runtime) !== subject) throw error("account_link_mismatch", 403);
      return db.transaction(() => {
        const scope = legacy(runtime);
        const existing = sql.query("SELECT * FROM zioon_memory_account_links WHERE subject=? OR legacy_scope=?")
          .all(subject, scope);
        if (existing.length) {
          if (existing.length === 1 && existing[0].subject === subject && existing[0].legacy_scope === scope) {
            return { linked: true, changed: false };
          }
          throw error("account_already_linked");
        }
        const oldUser = core.getUserByEmail(db, `${hash(scope)}@zion.invalid`);
        if (!oldUser) throw error("legacy_memory_not_found", 404);
        const target = core.getUserByEmail(db, `${hash(JSON.stringify(["adc", subject]))}@zion.invalid`);
        if (target && target.id !== oldUser.id) throw error("target_memory_already_exists");
        sql.query(`INSERT INTO zioon_memory_account_links (subject,legacy_scope,memory_user_id,linked_at)
          VALUES (?,?,?,?)`).run(subject, scope, oldUser.id, Date.now());
        return { linked: true, changed: true };
      });
    }
  };
}
