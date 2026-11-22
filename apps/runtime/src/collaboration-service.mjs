import { createHash, createHmac, randomBytes } from "node:crypto";
import { createDocumentVisitorRegistry } from "./sharing/document-visitor-registry.mjs";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";

export const COLLABORATION_PATH = "/v1/collaboration";
export const COLLABORATION_TEXT_KEY = "content";
export const COLLABORATION_PROTOCOL = "6";
const PROJECTABLE_RUN_EVENT_TYPES = new Set([
  "run.started",
  "reasoning.started",
  "reasoning.delta",
  "reasoning.completed",
  "message.delta",
  "message.completed",
  "tool.requested",
  "tool.completed",
  "tool.denied",
  "run.completed",
  "run.failed",
  "run.aborted"
]);

function collaborationDocumentName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 512 || name.includes("\0")) {
    throw new Error("Invalid collaboration document name");
  }
  return name;
}

function nodeRequestAsFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else if (value != null) {
      headers.set(name, String(value));
    }
  }
  return new Request(
    new URL(request.url || COLLABORATION_PATH, `http://${request.headers.host || "127.0.0.1"}`),
    { method: "GET", headers }
  );
}

function loopbackOriginAllowed(request) {
  const value = String(request.headers?.origin || "").trim();
  if (!value) return true;
  try {
    const origin = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(origin.hostname);
  } catch {
    return false;
  }
}

function stateHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function replaceYText(ytext, value) {
  const next = String(value || "");
  const current = ytext.toString();
  if (current === next) return false;
  ytext.doc.transact(() => {
    if (ytext.length) ytext.delete(0, ytext.length);
    if (next) ytext.insert(0, next);
  }, { source: "runtime" });
  return true;
}

export function authorizeCollaborationSends(webSocket, contexts, authorize) {
  const send = webSocket.send.bind(webSocket);
  let pending = [];
  let draining = false;
  webSocket.send = (...args) => {
    pending.push(args);
    if (draining) return;
    draining = true;
    void Promise.resolve().then(async () => {
      try {
        while (pending.length && webSocket.readyState === 1) {
          // Only this already queued batch shares a check. Frames arriving during
          // authorization are checked again, so revocation is never time-cached.
          const batch = pending;
          pending = [];
          for (const context of contexts) await authorize(context);
          if (webSocket.readyState === 1) for (const args of batch) send(...args);
        }
      } catch {
        webSocket.terminate();
      } finally {
        pending = [];
        draining = false;
      }
    });
  };
}

export function createRuntimeCollaborationService({
  store,
  documentProjector = null,
  path = COLLABORATION_PATH,
  authenticate = null,
  reauthorize = null,
  authorizeOutbound = null,
  withPersistence = null,
  allowOrigin = loopbackOriginAllowed,
  debounceMs = 250,
  maxDebounceMs = 2_000,
  checkpointDebounceMs = 1_000,
  runProjectionDebounceMs = 40
} = {}) {
  if (
    !store?.readCollaborationDocument
    || !store?.writeCollaborationDocument
    || !store?.readSession
  ) {
    throw new Error("Collaboration service requires a Workbench state store");
  }
  if (typeof allowOrigin !== "function") {
    throw new Error("Collaboration service requires an Origin policy");
  }
  if (reauthorize != null && typeof reauthorize !== "function") {
    throw new Error("Collaboration reauthorization must be a function");
  }
  let activeDocumentProjector = documentProjector;
  let closing = false;
  const readerVisits = createDocumentVisitorRegistry();
  const visitorSalt = randomBytes(32);
  const visitorId = (documentId, person) => createHmac("sha256", visitorSalt)
    .update(JSON.stringify([documentId, person.kind, person.id])).digest("base64url");
  const pendingAuthorizations = new Set();
  const authorize = async action => {
    if (closing) throw new Error("Collaboration is closing");
    const promise = Promise.resolve().then(action);
    pendingAuthorizations.add(promise);
    try { return await promise; }
    finally { pendingAuthorizations.delete(promise); }
  };
  const persist = (input, action) => withPersistence ? withPersistence(input, action) : action(undefined);
  const contributors = new Map();
  const persistenceFailures = new Map();
  const failedDocuments = new Set();
  let persistenceEpoch = 0;
  let contributionVersion = 0;
  const mutateDirect = (sessionId, connection, action) => {
    connection.persistenceEpoch = persistenceEpoch;
    return persist({
      sessionId, context: connection.context, contributors: [...(contributors.get(sessionId)?.keys() || [])], kind: "projection"
    }, () => connection.transact(action));
  };
  const disconnectDirect = async (sessionId, connection, options) => {
    const epoch = connection.persistenceEpoch ?? persistenceEpoch;
    // The upstream's debounced disconnect returns before the scheduled store.
    // Force this direct write to finish before acknowledging a projection.
    await connection.disconnect({ ...options, unloadImmediately: true });
    const failure = persistenceFailures.get(sessionId);
    // Hocuspocus deliberately swallows hook errors to retain the buffer. A Run
    // completion must still see the failed persistence and keep its retry task.
    if (failure?.epoch > epoch) throw failure.error;
  };

  const pendingDocumentCheckpoints = new Map();
  const flushDocumentCheckpoint = async (sessionId) => {
    const pending = pendingDocumentCheckpoints.get(sessionId);
    if (!pending) return null;
    if (pending.timer) clearTimeout(pending.timer);
    pendingDocumentCheckpoints.delete(sessionId);
    return persist({ sessionId, context: pending.context, kind: "checkpoint" }, async (tx) => {
      await store.checkpointSessionRevision?.(sessionId, { reason: "collaboration-checkpoint" }, tx);
      return await store.appendEvent?.("document.checkpointed", {
      sessionId,
      revision: await store.revision?.(),
      sessionRevision: pending.sessionRevision,
      sourceClientId: pending.sourceClientId,
      payload: {
        version: pending.version,
        stateHash: pending.stateHash
      }
      }, tx) || null;
    });
  };
  const scheduleDocumentCheckpoint = (result, sourceClientId, context) => {
    if (!result?.sessionId || result.duplicate) return;
    const sessionId = String(result.sessionId);
    const previous = pendingDocumentCheckpoints.get(sessionId);
    if (previous?.timer) clearTimeout(previous.timer);
    const pending = {
      sessionId,
      version: result.version,
      stateHash: result.stateHash,
      sessionRevision: result.session_revision,
      sourceClientId: String(sourceClientId || ""),
      context,
      timer: null
    };
    if (closing) {
      pendingDocumentCheckpoints.set(sessionId, pending);
      void flushDocumentCheckpoint(sessionId).catch(() => {});
      return;
    }
    pending.timer = setTimeout(
      () => {
        void flushDocumentCheckpoint(sessionId).catch(() => {});
      },
      Math.max(100, Number(checkpointDebounceMs) || 1_000)
    );
    pendingDocumentCheckpoints.set(sessionId, pending);
  };

  const hocuspocus = new Hocuspocus({
    quiet: true,
    debounce: Math.max(50, Number(debounceMs) || 250),
    maxDebounce: Math.max(250, Number(maxDebounceMs) || 2_000),
    flushDelay: 25,
    async onAuthenticate(input) {
      const documentName = collaborationDocumentName(input.documentName);
      const clientId = String(
        input.requestParameters.get("client_id")
        || input.context?.clientId
        || ""
      );
      const authorization = typeof authenticate === "function"
        ? await authorize(() => authenticate({
            documentName,
            token: input.token,
            headers: input.requestHeaders,
            parameters: input.requestParameters,
            clientId
          }))
        : {};
      if (authorization?.readOnly === true) input.connectionConfig.readOnly = true;
      input.context?.authorizationState?.contexts.add(authorization);
      return {
        ...(input.context || {}),
        ...(authorization || {}),
        clientId
      };
    },
    async beforeHandleMessage({ context }) {
      if (closing) return;
      if (reauthorize) await authorize(() => reauthorize(context));
    },
    beforeUnloadDocument({ documentName }) {
      if (failedDocuments.has(documentName)) throw new Error("Document persistence is still pending");
    },
    onChange({ documentName, context, transactionOrigin }) {
      if (transactionOrigin?.skipStoreHooks) return;
      const pending = contributors.get(documentName) || new Map();
      pending.set(context, ++contributionVersion);
      contributors.set(documentName, pending);
    },
    async onLoadDocument({ documentName, context }) {
      const sessionId = collaborationDocumentName(documentName);
      const [stored, session] = await Promise.all([
        store.readCollaborationDocument(sessionId),
        store.readSession(sessionId)
      ]);
      if (session?.deleted) throw new Error("Session has been deleted");
      if (stored?.state?.length) {
        const document = new Y.Doc();
        Y.applyUpdate(document, stored.state);
        const collaborationText = document
          .getText(COLLABORATION_TEXT_KEY)
          .toString();
        const snapshotText = session && !session.deleted
          ? String(session.text || "")
          : "";
        if (
          !session
          || session.deleted
          || collaborationText === snapshotText
          || Number(stored.updatedAt || 0) >= Number(session.updated_at || 0)
        ) {
          return document;
        }
      }
      const document = new Y.Doc();
      const text = session && !session.deleted ? String(session.text || "") : "";
      if (text) document.getText(COLLABORATION_TEXT_KEY).insert(0, text);
      await persist({ sessionId, context, kind: "bootstrap", text }, tx =>
        store.writeCollaborationDocument(sessionId, Y.encodeStateAsUpdate(document), {
          text, sourceClientId: "runtime-bootstrap"
        }, tx));
      return document;
    },
    async onStoreDocument({
      documentName,
      document,
      lastContext
    }) {
      const sessionId = collaborationDocumentName(documentName);
      const sourceClientId = String(lastContext?.clientId || "");
      const ytext = document.getText(COLLABORATION_TEXT_KEY);
      const nextText = ytext.toString();
      const state = Y.encodeStateAsUpdate(document);
      const contexts = new Map(contributors.get(sessionId) || []);
      try {
        const result = await persist({ sessionId, context: lastContext, contributors: [...contexts.keys()], kind: "store", text: nextText }, tx =>
          store.writeCollaborationDocument(sessionId, state, { text: nextText, sourceClientId, emitEvent: false }, tx));
        failedDocuments.delete(sessionId);
        for (const [context, version] of contexts) {
          if (contributors.get(sessionId)?.get(context) === version) contributors.get(sessionId).delete(context);
        }
        scheduleDocumentCheckpoint(result, sourceClientId, lastContext);
      } catch (error) {
        persistenceFailures.set(sessionId, { epoch: ++persistenceEpoch, error });
        if (![401, 403, 404].includes(error.statusCode) && error.code !== "collaboration_snapshot_changed") {
          failedDocuments.add(sessionId);
          throw error;
        }
        failedDocuments.delete(sessionId);
        // A rejected aggregate must never be saved later under another editor.
        // Drop peers and reload from the committed snapshot on their next join.
        hocuspocus.closeConnections(sessionId);
        const snapshot = await store.readSession(sessionId);
        const committed = await store.readCollaborationDocument(sessionId);
        const restored = new Y.Doc();
        if (committed?.state?.length) Y.applyUpdate(restored, committed.state);
        document.transact(() => {
          replaceYText(document.getText(COLLABORATION_TEXT_KEY), snapshot?.text || "");
          for (const [key, type] of document.share) {
            if (key === COLLABORATION_TEXT_KEY || !(type instanceof Y.Map)) continue;
            type.clear();
            for (const [name, value] of restored.getMap(key)) type.set(name, value);
          }
        }, { source: "local", skipStoreHooks: true });
        contributors.delete(sessionId);
        restored.destroy();
        throw error;
      }
    }
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024
  });
  const pendingRunProjections = new Map();

  const flushRunProjection = async (key) => {
    const pending = pendingRunProjections.get(key);
    if (!pending || pending.flushing) return pending?.flushing || null;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const projectedEvents = pending.events.splice(0);
    if (!projectedEvents.length) return null;
    const projectedSequence = Math.max(
      ...projectedEvents.map((event) => Number(event.sequence) || 0)
    );
    let failed = false;
    pending.flushing = (async () => {
      const connection = await hocuspocus.openDirectConnection(
        pending.sessionId,
        { clientId: "runtime", runtimeRunId: pending.runId }
      );
      try {
        await mutateDirect(pending.sessionId, connection, (document) => {
          if (
            activeDocumentProjector?.projectEvents
          ) {
            activeDocumentProjector.projectEvents({
              document,
              runId: pending.runId,
              events: projectedEvents,
              includeReasoning: pending.includeReasoning
            });
            return;
          }
          const runs = document.getMap("runs");
          const previous = runs.get(pending.runId) || {};
          if (
            Number(previous.lastSequence || 0) < projectedSequence
          ) {
            activeDocumentProjector?.projectRun?.({
              document,
              runId: pending.runId,
              output: pending.output,
              status: pending.status,
              terminal: pending.terminal,
              appendUserPrompt: pending.appendUserPrompt
            });
          }
          runs.set(pending.runId, {
            ...previous,
            lastSequence: projectedSequence,
            output: pending.output,
            status: pending.status
          });
        });
      } finally {
        await disconnectDirect(pending.sessionId, connection, { unloadImmediately: false });
      }
    })().catch((error) => {
      failed = true;
      pending.events.unshift(...projectedEvents);
      throw error;
    }).finally(() => {
      pending.flushing = null;
      if (pending.events.length && !failed) {
        return flushRunProjection(key);
      } else if (!pending.events.length && pending.terminal) {
        pendingRunProjections.delete(key);
      }
    });
    return pending.flushing;
  };

  const replaceDocument = async (sessionId, text, context = {}) => {
    const name = collaborationDocumentName(sessionId);
    const connection = await hocuspocus.openDirectConnection(name, {
      clientId: String(context.clientId || "runtime"), committedSnapshot: true
    });
    try {
      connection.persistenceEpoch = persistenceEpoch;
      await persist({ sessionId: name, context: connection.context, kind: "projection", text: String(text || "") },
        () => connection.transact((document) => {
        replaceYText(document.getText(COLLABORATION_TEXT_KEY), text);
      }));
    } finally {
      await disconnectDirect(name, connection);
    }
    return await store.readCollaborationDocument(name);
  };

  const storeSubscription = store.subscribeEvents?.((event) => {
    const sessionId = String(event?.sessionId || "");
    if (!sessionId) return;
    if (event.type === "session.deleted") {
      const pending = pendingDocumentCheckpoints.get(sessionId);
      if (pending?.timer) clearTimeout(pending.timer);
      pendingDocumentCheckpoints.delete(sessionId);
      hocuspocus.closeConnections(sessionId);
      return;
    }
    if (
      !["session.created", "session.updated"].includes(event.type)
      || event.data?.reason === "collaboration"
      || (
        event.type === "session.updated"
        && Array.isArray(event.data?.changed)
        && !event.data.changed.includes("document")
      )
      || !hocuspocus.documents.has(sessionId)
    ) {
      return;
    }
    void (async () => {
      const session = await store.readSession(sessionId);
      if (!session || session.deleted) return;
      await replaceDocument(sessionId, session.text, {
        clientId: event.sourceClientId || "runtime-http"
      });
    })().catch(() => {});
  }) || null;

  const handleUpgrade = (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(
        request.url || "/",
        `http://${request.headers.host || "127.0.0.1"}`
      );
    } catch {
      return false;
    }
    if (requestUrl.pathname !== path) return false;
    if (
      requestUrl.searchParams.get("protocol")
      !== COLLABORATION_PROTOCOL
    ) {
      socket.write(
        "HTTP/1.1 426 Upgrade Required\r\n"
        + "Connection: close\r\n"
        + "Clear-Site-Data: \"executionContexts\"\r\n"
        + `X-Zion-Collaboration-Protocol: ${COLLABORATION_PROTOCOL}\r\n\r\n`
      );
      socket.destroy();
      return true;
    }
    if (!allowOrigin(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      // Receiver errors belong to this peer. An unhandled WebSocket "error"
      // would otherwise terminate every account's Runtime and login routes.
      webSocket.on("error", (error) => {
        const oversized = error?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
        process.stderr.write(`[runtime-collaboration] ${oversized ? "message_too_large" : "socket_error"}\n`);
        // ws already starts a 1009 close for an oversized frame. Preserve it.
        if (webSocket.readyState === 1) {
          try {
            webSocket.close(oversized ? 1009 : 1011, "Collaboration connection rejected");
          } catch {
            webSocket.terminate();
          }
        }
      });
      const authorizationState = { contexts: new Set() };
      if (authorizeOutbound) {
        authorizeCollaborationSends(webSocket, authorizationState.contexts,
          context => authorize(() => authorizeOutbound(context)));
      }
      const connection = hocuspocus.handleConnection(
        webSocket,
        nodeRequestAsFetchRequest(request),
        {
          clientId: String(requestUrl.searchParams.get("client_id") || ""),
          ...(authorizeOutbound ? { authorizationState } : {})
        }
      );
      webSocket.on("message", (data) => {
        connection.handleMessage(new Uint8Array(data));
      });
      webSocket.on("close", (code, reason) => {
        connection.handleClose({
          code,
          reason: Buffer.from(reason || []).toString("utf8")
        });
      });
    });
    return true;
  };

  const collectDocumentPresence = async sessionId => {
    if (closing) return [];
    const document = hocuspocus.documents.get(collaborationDocumentName(sessionId));
    const people = new Map();
    for (const connection of document?.getConnections() || []) {
      const context = connection.context, principal = context?.principal;
      // Awareness is client-controlled. Identity comes only from authenticated sockets.
      if (connection.webSocket.readyState !== 1 || principal?.kind !== "account" || !principal.user?.id) continue;
      try {
        if (authorizeOutbound) await authorize(() => authorizeOutbound(context));
        else if (reauthorize) await authorize(() => reauthorize(context));
        if (connection.webSocket.readyState === 1 && document.getConnections().includes(connection)) people.set(`account:${principal.user.id}`,
          { kind: "account", id: principal.user.id, name: principal.user.name || "未命名用户", role: context.readOnly ? "viewer" : "editor" });
      } catch { /* Revoked and expired connections are not present. */ }
    }
    for (const person of await readerVisits.list(sessionId)) {
      const key = `${person.kind}:${person.id}`;
      if (!people.has(key)) people.set(key, person);
    }
    return [...people.values()];
  };

  return {
    path,
    hocuspocus,
    handleUpgrade,
    setDocumentProjector(projector) {
      activeDocumentProjector = projector || null;
    },
    stats() {
      return {
        documents: hocuspocus.getDocumentsCount(),
        connections: hocuspocus.getConnectionsCount()
      };
    },
    async listDocumentPresence(sessionId) {
      return (await collectDocumentPresence(sessionId)).filter(person => person.kind === "account").map(person => person.id);
    },
    async listDocumentVisitors(sessionId, options = {}) {
      const people = await collectDocumentPresence(sessionId);
      return {
        selfVisitorId: options.self ? visitorId(sessionId, options.self) : null,
        visitors: people.slice(0, 100).map(person => ({
          id: visitorId(sessionId, person), kind: person.kind, online: true,
          name: options.public && person.kind === "account" ? "已登录访客" : person.name,
          role: options.public ? "visitor" : person.role,
          ...(options.accountIds && person.kind === "account" ? { accountId: person.id } : {})
        }))
      };
    },
    registerDocumentVisit: (documentId, input) => readerVisits.register(documentId, input),
    renewDocumentVisit: (documentId, id, input) => readerVisits.renew(documentId, id, input),
    removeDocumentVisit: (documentId, id, input) => readerVisits.remove(documentId, id, input),
    replaceDocument,
    async applyRunEvents(sessionId, { runId, events, includeReasoning, mode } = {}) {
      const connection = await hocuspocus.openDirectConnection(collaborationDocumentName(sessionId), { clientId: "runtime", runtimeRunId: runId });
      try {
        await mutateDirect(sessionId, connection, document => {
          if (["live", "final"].includes(mode)) {
            const projection = document.getMap("runProjection").get(runId);
            // A user-detached working copy needs no further document replay.
            // Its captured anchor may remain unresolved after an edit.
            if (projection?.mode === mode && projection.detached) return;
            if (!projection || projection.pendingAnchor || projection.mode !== mode) {
              throw new Error("Snapshot document anchor is not prepared");
            }
          }
          activeDocumentProjector?.projectEvents?.({ document, runId, events, includeReasoning });
        });
      } finally {
        await disconnectDirect(sessionId, connection, { unloadImmediately: false });
      }
    },
    async prepareRun(sessionId, input = {}) {
      if (!activeDocumentProjector?.prepareRun) return null;
      const name = collaborationDocumentName(sessionId);
      const connection = await hocuspocus.openDirectConnection(name, {
        clientId: "runtime", runtimeRunId: input.runId
      });
      try {
        await mutateDirect(name, connection, (document) => {
          activeDocumentProjector.prepareRun({
            document,
            ...input
          });
        });
      } finally {
        await disconnectDirect(name, connection, { unloadImmediately: false });
      }
      return input.returnSnapshot === false ? null : await store.readCollaborationDocument(name);
    },
    async projectAssistantOutput(sessionId, input = {}) {
      if (!activeDocumentProjector?.projectRun) return null;
      const name = collaborationDocumentName(sessionId);
      const connection = await hocuspocus.openDirectConnection(name, {
        clientId: "runtime", runtimeRunId: input.runId
      });
      try {
        await mutateDirect(name, connection, (document) => {
          activeDocumentProjector.projectRun({
            document,
            ...input,
            status: input.status || "running",
            terminal: false,
            appendUserPrompt: false
          });
        });
      } finally {
        await disconnectDirect(name, connection);
      }
      return await store.readCollaborationDocument(name);
    },
    async reconcileTranscript(sessionId, messages = [], runId) {
      if (!activeDocumentProjector?.reconcileTranscript) return null;
      const name = collaborationDocumentName(sessionId);
      const connection = await hocuspocus.openDirectConnection(name, {
        clientId: "runtime", runtimeRunId: runId
      });
      try {
        await mutateDirect(name, connection, (document) => {
          activeDocumentProjector.reconcileTranscript({
            document,
            messages
          });
        });
      } finally {
        await disconnectDirect(name, connection, { unloadImmediately: false });
      }
      return await store.readCollaborationDocument(name);
    },
    async applyRunEvent(sessionId, event = {}, options = {}) {
      const runId = String(event.runId || "");
      const name = collaborationDocumentName(sessionId);
      if (!runId) return null;
      if (!PROJECTABLE_RUN_EVENT_TYPES.has(event.type)) return null;
      const messageDelta = event.type === "message.delta"
        ? String(event.data?.delta || "")
        : "";
      const messageCompleted = event.type === "message.completed";
      const completedContent = messageCompleted
        ? String(event.data?.content || "")
        : "";
      const terminal = ["run.completed", "run.failed", "run.aborted"]
        .includes(event.type);
      const key = `${name}:${runId}`;
      const pending = pendingRunProjections.get(key) || {
        key,
        sessionId: name,
        runId,
        events: [],
        output: "",
        turnOutput: new Map(),
        status: "running",
        lastSequence: 0,
        messageCompleted: false,
        appendUserPrompt: false,
        includeReasoning: true,
        terminal: false,
        timer: null,
        flushing: null
      };
      pending.appendUserPrompt = pending.appendUserPrompt
        || options.appendUserPrompt === true;
      if (options.includeReasoning === false) pending.includeReasoning = false;
      pending.lastSequence = Math.max(
        pending.lastSequence,
        Number(event.sequence) || 0
      );
      if (messageDelta) {
        pending.output += messageDelta;
        const turn = String(event.data?.turn ?? "");
        pending.turnOutput.set(
          turn,
          String(pending.turnOutput.get(turn) || "") + messageDelta
        );
      }
      pending.events.push(event);
      pendingRunProjections.set(key, pending);
      if (messageCompleted) {
        const turn = String(event.data?.turn ?? "");
        const streamedTurn = String(pending.turnOutput.get(turn) || "");
        if (!streamedTurn) {
          pending.output += completedContent;
        } else if (streamedTurn !== completedContent) {
          pending.output = pending.output.endsWith(streamedTurn)
            ? pending.output.slice(0, -streamedTurn.length) + completedContent
            : pending.output + completedContent;
        }
        pending.turnOutput.delete(turn);
        pending.messageCompleted = true;
      }
      if (terminal) {
        pending.status = event.type.slice("run.".length);
        pending.terminal = true;
        if (
          event.type === "run.completed"
          && event.data?.output
        ) {
          pending.output = String(event.data.output);
        }
      }
      if (
        event.type === "message.delta"
        || event.type === "reasoning.delta"
      ) {
        if (!pending.timer) {
          pending.timer = setTimeout(() => {
            pending.timer = null;
            void flushRunProjection(pending.key).catch(() => {});
          }, Math.max(10, Number(runProjectionDebounceMs) || 40));
        }
        return null;
      }
      const flushing = flushRunProjection(pending.key);
      if (options.deferFlush === true && !terminal) {
        void flushing.catch(() => {});
        return null;
      }
      return flushing;
    },
    async close() {
      closing = true;
      readerVisits.close();
      storeSubscription?.dispose?.();
      for (const pending of pendingRunProjections.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = null;
        await flushRunProjection(pending.key);
      }
      for (const sessionId of [...pendingDocumentCheckpoints.keys()]) {
        await flushDocumentCheckpoint(sessionId);
      }
      hocuspocus.closeConnections();
      for (const client of webSocketServer.clients) client.terminate();
      await Promise.allSettled([...pendingAuthorizations]);
      hocuspocus.flushPendingStores();
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const busy = [...hocuspocus.documents.values()].some((document) => {
          const debounceId = `onStoreDocument-${document.name}`;
          return hocuspocus.debouncer.isDebounced(debounceId)
            || hocuspocus.debouncer.isCurrentlyExecuting(debounceId)
            || document.saveMutex?.isLocked?.();
        });
        if (!busy) break;
        hocuspocus.flushPendingStores();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      for (const sessionId of [...pendingDocumentCheckpoints.keys()]) {
        await flushDocumentCheckpoint(sessionId);
      }
      await new Promise((resolve) => {
        try {
          webSocketServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
    stateHash
  };
}
