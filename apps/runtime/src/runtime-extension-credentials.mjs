export function environmentExtensionSecret(ref, environment = process.env) {
  if (!/^ZION_(?:WEBHOOK|HOOK)_SECRET_[A-Z0-9_]{1,80}$/.test(ref || "")) {
    throw new Error("Invalid extension secret reference");
  }
  const secret = environment[ref];
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new Error("Extension signing secret must contain at least 32 bytes");
  }
  return secret;
}

/** Operator-owned bindings prevent an account from borrowing another signing key. */
export function environmentWebhookSecret(ref, { spaceId, purpose = "webhook" } = {}, environment = process.env) {
  if (purpose !== "webhook" || !/^ZION_WEBHOOK_SECRET_[A-Z0-9_]{1,80}$/.test(ref || "") || !spaceId) {
    throw new Error("Invalid Webhook signing secret reference");
  }
  const bindings = JSON.parse(environment.ZION_WEBHOOK_SECRET_BINDINGS || "{}");
  const allowed = Object.hasOwn(bindings, spaceId) ? bindings[spaceId] : null;
  if (!Array.isArray(allowed) || !allowed.includes(ref)) {
    throw new Error("Webhook signing secret is not authorized for this Space");
  }
  return environmentExtensionSecret(ref, environment);
}
