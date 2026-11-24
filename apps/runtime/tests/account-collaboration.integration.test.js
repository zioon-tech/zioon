import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { AccountAccessControl } from "../src/accounts/account-access-control.mjs";
import { createRuntimeCollaborationService, COLLABORATION_TEXT_KEY } from "../src/collaboration-service.mjs";
import { createSessionDocumentProjector } from "../../../extensions/dev.session-manager/session-document-projector.js";
import { createRuntimeServer } from "../src/server.mjs";
import {
  createPostgresTestDatabase,
  provisionTestTeam
} from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function connect(url, token, failures = []) {
  const document = new Y.Doc();
  let provider;
  await new Promise((resolve, reject) => {
    provider = new HocuspocusProvider({
      url, name: "shared", document, token, WebSocketPolyfill: WebSocket,
      onSynced() { resolve(); },
      onAuthenticationFailed({ reason }) { failures.push(reason); reject(new Error(reason)); }
    });
    cleanup.push(() => { provider.destroy(); document.destroy(); });
  });
  return { provider, document, text: document.getText(COLLABORATION_TEXT_KEY) };
}

it("enforces account viewer writes and stops delivering Yjs updates after membership removal", async () => {
  const database = await createPostgresTestDatabase("account_collaboration");
  cleanup.push(() => database.close());
  const { accounts } = database;
  const owner = await provisionTestTeam(database, {
    spaceId: "space:a",
    issuer: "https://id.test"
  });
  const devices = new PostgresAccessStore(database.pool, { spaceId: "space:a" });
  const runs = new PostgresRunStore(database.pool, { spaceId: "space:a" });
  const state = await new PostgresWorkbenchStateStore(database.pool, {
    spaceId: "space:a"
  }).initialize();
  const viewer = await accounts.resolveIdentity({
    issuer: "https://id.test",
    subject: "viewer"
  });
  await accounts.acceptInvitation(
    viewer.id,
    (await accounts.invite(owner.id, { role: "viewer" }, "space:a")).token
  );
  const ownerSession = await accounts.createSession(owner.id, {
    activeSpaceId: "space:a"
  });
  const viewerSession = await accounts.createSession(viewer.id, {
    activeSpaceId: "space:a"
  });
  const access = new AccountAccessControl({
    accounts,
    store: devices,
    oidc: {},
    servedSpaceId: "space:a"
  });
  let viewerChecks = 0;
  let deniedDelivery = 0;
  const collaboration = createRuntimeCollaborationService({
    store: state, documentProjector: createSessionDocumentProjector(),
    authenticate: (input) => access.authenticateCollaboration(input),
    async reauthorize(context) {
      if (context.principal.user.id === viewer.id) viewerChecks++;
      await access.reauthorize(
        context.principal,
        context.readOnly ? "runtime.read" : "collaboration.write"
      );
    },
    async authorizeOutbound(context) {
      try { await access.reauthorize(context.principal, "runtime.read"); }
      catch (error) { deniedDelivery++; throw error; }
    }
  });
  cleanup.push(() => collaboration.close());
  await state.createSession({ id: "shared", title: "Shared", text: "initial" });
  const server = createRuntimeServer({
    runs, executor: { execute() { throw new Error("Not used"); } },
    port: 0, upgradeHandlers: [collaboration.handleUpgrade]
  });
  cleanup.push(() => server.close());
  const address = await server.start();
  const url = address.url.replace(/^http/, "ws") + "/v1/collaboration?protocol=8";
  const editor = await connect(url, ownerSession.token);
  const reader = await connect(url, viewerSession.token);
  expect(reader.text.toString()).toBe("initial");
  const baseline = viewerChecks;
  reader.text.insert(0, "forbidden edit ");
  await vi.waitFor(() => expect(viewerChecks).toBeGreaterThan(baseline));
  editor.text.insert(editor.text.length, " authorized update");
  await vi.waitFor(() => expect(reader.text.toString()).toContain("authorized update"));
  expect(editor.text.toString()).toBe("initial authorized update");
  const authoritative = await collaboration.hocuspocus.openDirectConnection("shared");
  await authoritative.transact((document) => {
    expect(document.getText(COLLABORATION_TEXT_KEY).toString()).toBe("initial authorized update");
  });
  await authoritative.disconnect({ unloadImmediately: false });
  await accounts.setMember(
    owner.id,
    viewer.id,
    { role: "viewer", status: "removed" },
    "space:a"
  );
  editor.text.insert(editor.text.length, " after removal secret");
  await vi.waitFor(() => expect(deniedDelivery).toBeGreaterThan(0));
  expect(reader.text.toString()).not.toContain("after removal secret");
}, 10_000);
