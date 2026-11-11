import { json, readJson } from "./access-control.mjs";
import { extensionEndpoint } from "./extension-http-transport.mjs";
import { environmentWebhookSecret } from "./runtime-extension-credentials.mjs";
import { WEBHOOK_EVENT_TYPES } from "./postgres-webhook-store.mjs";

export function createWebhookHttpHandler({ store, accessControl, trustedOrigins = [],
  secret = environmentWebhookSecret }) {
  const authorizeSecret = (ref) => secret(ref, { spaceId: store.spaceId, purpose: "webhook" });
  return async (request, response, url) => {
    if (!/^\/v1\/webhooks(?:\/|$)/.test(url.pathname)) return false;
    const principal = request.zionPrincipal;
    if (accessControl) {
      if (principal?.kind === "account") {
        await accessControl.requireScope(principal, "runtime.manage");
        if (principal.space?.id !== store.spaceId) {
          throw Object.assign(new Error("Webhook not found"), { statusCode: 404 });
        }
      } else {
        // Pairing owners already hold this management scope, including existing
        // credentials. Client/resource credentials cannot manage subscriptions.
        if (principal?.device?.kind !== "owner") {
          throw Object.assign(new Error("Webhook management requires an owner"), { statusCode: principal ? 403 : 401 });
        }
        await accessControl.requireScope(principal, "pairing.manage");
      }
    }
    const actorId = principal?.user?.id || principal?.credentialId || "local";
    const path = url.pathname;
    if (request.method === "GET" && path === "/v1/webhooks") {
      json(response, 200, { subscriptions: await store.list(), eventTypes: WEBHOOK_EVENT_TYPES });
    } else if (request.method === "POST" && path === "/v1/webhooks") {
      const body = await readJson(request, 16 * 1024);
      let endpoint;
      try {
        endpoint = extensionEndpoint(body.endpoint, { trustedOrigins }).href;
        authorizeSecret(body.secretRef);
      } catch { throw Object.assign(new Error("Invalid endpoint or signing secret reference"), { statusCode: 400 }); }
      json(response, 201, await store.create({ endpoint, secretRef: body.secretRef, eventTypes: body.eventTypes }, actorId));
    } else if (request.method === "GET" && path === "/v1/webhooks/deliveries") {
      json(response, 200, { deliveries: await store.deliveries({
        subscriptionId: url.searchParams.get("subscriptionId"),
        before: url.searchParams.get("before"), limit: url.searchParams.get("limit")
      }) });
    } else {
      const replay = path.match(/^\/v1\/webhooks\/deliveries\/([^/]+)\/replay$/);
      const audit = path.match(/^\/v1\/webhooks\/deliveries\/([^/]+)\/replays$/);
      const update = path.match(/^\/v1\/webhooks\/([^/]+)$/);
      if (request.method === "POST" && replay) {
        const body = await readJson(request, 4096);
        const subscription = await store.subscriptionForDelivery(decodeURIComponent(replay[1]));
        if (!subscription) throw Object.assign(new Error("Delivery not found"), { statusCode: 404 });
        authorizeSecret(subscription.secretRef);
        json(response, 200, await store.replay(decodeURIComponent(replay[1]), { actorId, reason: body.reason }));
      } else if (request.method === "GET" && audit) {
        json(response, 200, { replays: await store.audit(decodeURIComponent(audit[1])) });
      } else if (request.method === "PATCH" && update) {
        const body = await readJson(request, 4096);
        if (body.enabled === true) {
          const subscription = await store.get(decodeURIComponent(update[1]));
          if (!subscription) throw Object.assign(new Error("Webhook not found"), { statusCode: 404 });
          authorizeSecret(subscription.secretRef);
        }
        const result = await store.setEnabled(decodeURIComponent(update[1]), body.enabled);
        if (!result) throw Object.assign(new Error("Webhook not found"), { statusCode: 404 });
        json(response, 200, result);
      } else throw Object.assign(new Error("Webhook route not found"), { statusCode: 404 });
    }
    return true;
  };
}
