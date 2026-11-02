import { readFile } from "node:fs/promises";
import { createAccountProvider, registerAccountRoutes } from "./zioon-provider.mjs";

export async function registerZioonAccounts(app, access) {
  if (!process.env.ZIOON_ACCOUNT_ISSUER) return;
  const { adapter } = await access.authentication.auth.$context;
  const provider = await createAccountProvider({
    pool: access.identity.pool,
    issuer: process.env.ZIOON_ACCOUNT_ISSUER,
    adcOrigin: access.origin,
    clients: JSON.parse(await readFile(process.env.ZIOON_ACCOUNT_CLIENTS_FILE, "utf8")),
    privateKey: await readFile(process.env.ZIOON_ACCOUNT_SIGNING_KEY_FILE, "utf8"),
    async getSession(sessionId) {
      const session = await adapter.findOne({ model: "session", where: [{ field: "id", value: sessionId }] });
      if (!session) return null;
      const user = await adapter.findOne({ model: "user", where: [{ field: "id", value: session.userId }] });
      return user ? { session, user } : null;
    }
  });
  registerAccountRoutes(app, provider, {
    nativeAuth: access.authentication,
    authenticate: (request) => access.authenticate(request),
    readSession: (request) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== "host" && name !== "forwarded"
          && !name.startsWith("x-forwarded-") && name !== "x-adc-client-ip") {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      headers.set("x-adc-client-ip", request.ip);
      return access.authentication.auth.api.getSession({ headers });
    }
  });
}
