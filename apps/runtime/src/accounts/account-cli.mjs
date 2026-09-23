import process from "node:process";
import { pathToFileURL } from "node:url";
import { PostgresAccountStore } from "./postgres-account-store.mjs";

export async function bootstrapAccountOwner({
  argv = process.argv.slice(2), environment = process.env, output = process.stdout
} = {}) {
  const arg = (name, fallback = "") => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
  };
  const command = argv[0];
  if (command !== "bootstrap" || argv.includes("--help")) {
    output.write(
      "Usage:\n"
      + "  node apps/runtime/src/accounts/account-cli.mjs bootstrap "
      + "--space <opaque-id> --issuer <oidc-issuer> --subject <owner-sub> "
      + "[--name <space-name>]\n"
    );
    return;
  }
  const spaceId = arg("--space", environment.ZION_SPACE_ID);
  if (!spaceId) throw new Error("Explicit Space ID is required");
  const databaseUrl = String(environment.ZION_DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("ZION_DATABASE_URL is required");
  const issuer = arg("--issuer", environment.ZION_OIDC_ISSUER);
  const subject = arg("--subject");
  if (!issuer || !subject) throw new Error("Explicit issuer and subject are required");
  new URL(issuer);
  const store = await new PostgresAccountStore({
    connectionString: databaseUrl,
    ssl: environment.ZION_DATABASE_SSL === "disable" ? false : undefined
  }).initialize();
  try {
    const user = await store.resolveIdentity({
      issuer,
      subject,
      name: arg("--owner-name", subject)
    });
    const result = await store.transaction(async (client) => {
      const existing = await store.space(spaceId, client);
      if (existing) {
        const membership = await store.membership(user.id, spaceId, client);
        if (!membership || membership.role !== "owner" || membership.status !== "active") {
          throw new Error("Configured Space already exists with another owner");
        }
        return { user, space: existing, membership };
      }
      const createdAt = Date.now();
      const space = (await client.query(
        `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
         VALUES ($1, $2, 'team', $3, $4) RETURNING *`,
        [spaceId, arg("--name", environment.ZION_SPACE_NAME || spaceId), user.id, createdAt]
      )).rows[0];
      await client.query(
        `INSERT INTO account_memberships
         (space_id, user_id, role, status, revision, created_at, updated_at)
         VALUES ($1, $2, 'owner', 'active', 1, $3, $3)`,
        [spaceId, user.id, createdAt]
      );
      return {
        user,
        space: {
          id: space.id,
          name: space.name,
          kind: space.kind,
          createdBy: space.created_by,
          createdAt: Number(space.created_at)
        },
        membership: await store.membership(user.id, spaceId, client)
      };
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapAccountOwner().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
