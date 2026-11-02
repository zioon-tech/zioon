import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const [memoryFile] = process.argv.slice(2);
const sqlite = new Database(memoryFile, { readonly: true });
try {
  const links = sqlite.query("SELECT subject,legacy_scope FROM zioon_memory_account_links").all();
  const legacyUsers = sqlite.query("SELECT email FROM users WHERE email LIKE '%@zion.invalid'").all();
  const mapped = new Set(links.flatMap((link) => [link.legacy_scope, JSON.stringify(["adc", link.subject])]
    .map((scope) => `${createHash("sha256").update(scope).digest("hex")}@zion.invalid`)));
  // Only the Memory data binding changes. Runtime identities remain untouched.
  const unmapped = legacyUsers.filter((user) => !mapped.has(user.email));
  console.log(JSON.stringify({ scope: "memory-only", existingMemoryAccounts: legacyUsers.length,
    missingMemoryLinks: unmapped.length }));
  if (unmapped.length) throw new Error("Bind each existing Memory account before opening the website");
} finally {
  sqlite.close();
}
