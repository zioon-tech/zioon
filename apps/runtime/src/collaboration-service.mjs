import { createHash } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";

export const COLLABORATION_PATH = "/v1/collaboration";
export const COLLABORATION_TEXT_KEY = "content";
export const COLLABORATION_PROTOCOL = "5";

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

export function createRuntimeCollaborationService({
  store,
  documentProjector = null,
  path = COLLABORATION_PATH,
  authenticate = null,
  reauthorize = null,
  allowOrigin = loopbackOriginAllowed,
  debounceMs = 250,
  maxDebounceMs = 2_000,
  checkpointDebounceMs = 1_000
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

  const pendingDocumentCheckpoints = new Map();
  const flushDocumentCheckpoint = (sessionId) => {
    const pending = pendingDocumentCheckpoints.get(sessionId);
    if (!pending) return null;
    if (pending.timer) clearTimeout(pending.timer);
    pendingDocumentCheckpoints.delete(sessionId);
    return store.appendEvent?.("document.checkpointed", {
      sessionId,
      revision: store.revision?.(),
      sessionRevision: pending.sessionRevision,
      sourceClientId: pending.sourceClientId,
      payload: {
        version: pending.version,
        stateHash: pending.stateHash
      }
    }) || null;
  };
  const scheduleDocumentCheckpoint = (result, sourceClientId) => {
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
      timer: null
    };
    if (closing) {
      pendingDocumentCheckpoints.set(sessionId, pending);
      flushDocumentCheckpoint(sessionId);
      return;
    }
    pending.timer = setTimeout(
      () => flushDocumentCheckpoint(sessionId),
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
        ? await authenticate({
            documentName,
            token: input.token,
            headers: input.requestHeaders,
            clientId
          })
        : {};
      return {
        ...(input.context || {}),
        ...(authorization || {}),
        clientId
      };
    },
    async beforeHandleMessage({ context }) {
      if (reauthorize) await reauthorize(context);
    },
    async onLoadDocument({ documentName }) {
      const sessionId = collaborationDocumentName(documentName);
      const stored = store.readCollaborationDocument(sessionId);
      const session = store.readSession(sessionId);
      if (stored?.state?.length) {
        const document = new Y.Doc();
        Y.applyUpdate(document, stored.state);
        const collaborationText = document
          .getText(COLLABORATION_TEXT_KEY)
          .toString();
        // #region debug-point B:collaboration-load-candidates
        globalThis.fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"B",location:"apps/runtime/src/collaboration-service.mjs:onLoadDocument",msg:"[DEBUG] Compared stored collaboration state with Workbench snapshot",data:{runtimeSessionId:sessionId,collaborationLength:collaborationText.length,collaborationRoles:Array.from(collaborationText.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),collaborationMarkers:(collaborationText.match(/zion-assistant:id=/g)||[]).length,collaborationUpdatedAt:Number(stored.updatedAt||0),snapshotExists:!!session&&!session.deleted,snapshotLength:String(session?.text||"").length,snapshotRoles:Array.from(String(session?.text||"").matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),snapshotUpdatedAt:Number(session?.updated_at||0)},ts:Date.now()})}).catch(()=>{});
        // #endregion
        if (
          !session
          || session.deleted
          || collaborationText === String(session.text || "")
          || Number(stored.updatedAt || 0) >= Number(session.updated_at || 0)
        ) {
          return document;
        }
      }
      const document = new Y.Doc();
      const text = session && !session.deleted ? String(session.text || "") : "";
      // #region debug-point B:collaboration-bootstrap-source
      globalThis.fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"B",location:"apps/runtime/src/collaboration-service.mjs:onLoadDocument-bootstrap",msg:"[DEBUG] Bootstrapping collaboration state from Workbench snapshot",data:{runtimeSessionId:sessionId,storedStateExists:!!stored?.state?.length,snapshotExists:!!session&&!session.deleted,snapshotLength:text.length,snapshotRoles:Array.from(text.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1])},ts:Date.now()})}).catch(()=>{});
      // #endregion
      if (text) document.getText(COLLABORATION_TEXT_KEY).insert(0, text);
      store.writeCollaborationDocument(
        sessionId,
        Y.encodeStateAsUpdate(document),
        {
          text,
          sourceClientId: "runtime-bootstrap"
        }
      );
      return document;
    },
    async onStoreDocument({
      documentName,
      document,
      lastContext
    }) {
      const sessionId = collaborationDocumentName(documentName);
      const state = Y.encodeStateAsUpdate(document);
      const sourceClientId = String(lastContext?.clientId || "");
      const nextText = document.getText(COLLABORATION_TEXT_KEY).toString();
      const result = store.writeCollaborationDocument(sessionId, state, {
        text: nextText,
        sourceClientId,
        emitEvent: false
      });
      scheduleDocumentCheckpoint(result, sourceClientId);
    }
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024
  });
  const pendingRunProjections = new Map();

  const hasConnectedClient = (documentName, clientId) => {
    const expected = String(clientId || "");
    if (!expected) return false;
    const document = hocuspocus.documents.get(documentName);
    if (!document?.getConnections) return false;
    return document.getConnections().some((connection) =>
      String(connection?.context?.clientId || "") === expected
    );
  };

  const flushRunProjection = async (key) => {
    const pending = pendingRunProjections.get(key);
    if (!pending || pending.flushing) return pending?.flushing || null;
    const projectedSequence = pending.lastSequence;
    const projectedOutput = pending.output;
    const projectedStatus = pending.status;
    const appendUserPrompt = pending.appendUserPrompt === true;
    const writerConnected = hasConnectedClient(
      pending.sessionId,
      pending.writerClientId
    );
    pending.flushing = (async () => {
      const connection = await hocuspocus.openDirectConnection(
        pending.sessionId,
        { clientId: "runtime" }
      );
      try {
        await connection.transact((document) => {
          const runs = document.getMap("runs");
          const previous = runs.get(pending.runId) || {};
          if (Number(previous.lastSequence || 0) >= projectedSequence) return;
          if (!writerConnected) {
            activeDocumentProjector?.projectRun?.({
              document,
              runId: pending.runId,
              output: projectedOutput,
              status: projectedStatus,
              terminal: pending.terminal,
              appendUserPrompt
            });
          }
          const debugProjectedText = document.getText(COLLABORATION_TEXT_KEY).toString();
          // #region debug-point A:assistant-run-projection
          globalThis.fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"A",location:"apps/runtime/src/collaboration-service.mjs:flushRunProjection",msg:"[DEBUG] Projected assistant output into collaboration document",data:{runtimeSessionId:pending.sessionId,runtimeRunId:pending.runId,sequence:projectedSequence,status:projectedStatus,writerConnected,appendUserPrompt,outputLength:projectedOutput.length,documentLength:debugProjectedText.length,documentRoles:Array.from(debugProjectedText.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),documentMarkers:(debugProjectedText.match(/zion-assistant:id=/g)||[]).length},ts:Date.now()})}).catch(()=>{});
          // #endregion
          runs.set(pending.runId, {
            lastSequence: projectedSequence,
            output: projectedOutput,
            status: projectedStatus,
            writerClientId: pending.writerClientId || null
          });
        });
      } finally {
        await connection.disconnect({ unloadImmediately: false });
      }
    })().finally(() => {
      pending.flushing = null;
      if (pending.lastSequence > projectedSequence) {
        void flushRunProjection(key);
      } else if (pending.terminal) {
        pendingRunProjections.delete(key);
      }
    });
    return pending.flushing;
  };

  const replaceDocument = async (sessionId, text, context = {}) => {
    const name = collaborationDocumentName(sessionId);
    const connection = await hocuspocus.openDirectConnection(name, {
      clientId: String(context.clientId || "runtime")
    });
    try {
      await connection.transact((document) => {
        replaceYText(document.getText(COLLABORATION_TEXT_KEY), text);
      });
    } finally {
      await connection.disconnect();
    }
    return store.readCollaborationDocument(name);
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
    const session = store.readSession(sessionId);
    if (!session || session.deleted) return;
    void replaceDocument(sessionId, session.text, {
      clientId: event.sourceClientId || "runtime-http"
    });
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
      const connection = hocuspocus.handleConnection(
        webSocket,
        nodeRequestAsFetchRequest(request),
        {
          clientId: String(requestUrl.searchParams.get("client_id") || "")
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
    replaceDocument,
    async prepareRun(sessionId, input = {}) {
      if (!activeDocumentProjector?.prepareRun) return null;
      const name = collaborationDocumentName(sessionId);
      const connection = await hocuspocus.openDirectConnection(name, {
        clientId: "runtime"
      });
      try {
        await connection.transact((document) => {
          const debugTextBeforePrepare = document.getText(COLLABORATION_TEXT_KEY).toString();
          activeDocumentProjector.prepareRun({
            document,
            ...input
          });
          const debugTextAfterPrepare = document.getText(COLLABORATION_TEXT_KEY).toString();
          // #region debug-point A:prepare-run-document
          globalThis.fetch("http://127.0.0.1:7777/event",{method:"POST",body:JSON.stringify({sessionId:"mobile-desktop-transcript",runId:"post-fix",hypothesisId:"A",location:"apps/runtime/src/collaboration-service.mjs:prepareRun",msg:"[DEBUG] Projected submitted user message into collaboration document",data:{runtimeSessionId:name,runtimeRunId:String(input.runId||""),beforeLength:debugTextBeforePrepare.length,beforeRoles:Array.from(debugTextBeforePrepare.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),afterLength:debugTextAfterPrepare.length,afterRoles:Array.from(debugTextAfterPrepare.matchAll(/^(user|assistant|system|tool)(?:\s|$)/gm),(match)=>match[1]),afterMarkers:(debugTextAfterPrepare.match(/zion-assistant:id=/g)||[]).length,userContentLength:String(input.userContent||"").length},ts:Date.now()})}).catch(()=>{});
          // #endregion
        });
      } finally {
        await connection.disconnect({ unloadImmediately: false });
      }
      return store.readCollaborationDocument(name);
    },
    async projectAssistantOutput(sessionId, input = {}) {
      if (!activeDocumentProjector?.projectRun) return null;
      const name = collaborationDocumentName(sessionId);
      const connection = await hocuspocus.openDirectConnection(name, {
        clientId: "runtime"
      });
      try {
        await connection.transact((document) => {
          activeDocumentProjector.projectRun({
            document,
            ...input,
            status: input.status || "running",
            terminal: false,
            appendUserPrompt: false
          });
        });
      } finally {
        await connection.disconnect();
      }
      return store.readCollaborationDocument(name);
    },
    async reconcileTranscript(sessionId, messages = []) {
      if (!activeDocumentProjector?.reconcileTranscript) return null;
      const name = collaborationDocumentName(sessionId);
      const connection = await hocuspocus.openDirectConnection(name, {
        clientId: "runtime"
      });
      try {
        await connection.transact((document) => {
          activeDocumentProjector.reconcileTranscript({
            document,
            messages
          });
        });
      } finally {
        await connection.disconnect({ unloadImmediately: false });
      }
      return store.readCollaborationDocument(name);
    },
    async applyRunEvent(sessionId, event = {}, options = {}) {
      const runId = String(event.runId || "");
      const name = collaborationDocumentName(sessionId);
      if (!runId) return null;
      const messageDelta = event.type === "message.delta"
        ? String(event.data?.delta || "")
        : "";
      const messageCompleted = event.type === "message.completed";
      const completedContent = messageCompleted
        ? String(event.data?.content || "")
        : "";
      const terminal = ["run.completed", "run.failed", "run.aborted"]
        .includes(event.type);
      if (!messageDelta && !messageCompleted && !terminal) return null;
      const key = `${name}:${runId}`;
      const pending = pendingRunProjections.get(key) || {
        key,
        sessionId: name,
        runId,
        output: "",
        turnOutput: new Map(),
        status: "running",
        lastSequence: 0,
        messageCompleted: false,
        appendUserPrompt: false,
        writerClientId: "",
        terminal: false,
        flushing: null
      };
      pending.appendUserPrompt = pending.appendUserPrompt
        || options.appendUserPrompt === true;
      pending.writerClientId = String(
        options.documentWriterClientId
        || pending.writerClientId
        || ""
      );
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
      pendingRunProjections.set(key, pending);
      if (messageDelta && !messageCompleted && !terminal) return null;
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
      return flushRunProjection(pending.key);
    },
    async close() {
      closing = true;
      storeSubscription?.dispose?.();
      for (const pending of pendingRunProjections.values()) {
        await flushRunProjection(pending.key);
      }
      for (const sessionId of [...pendingDocumentCheckpoints.keys()]) {
        flushDocumentCheckpoint(sessionId);
      }
      hocuspocus.closeConnections();
      for (const client of webSocketServer.clients) client.terminate();
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
        flushDocumentCheckpoint(sessionId);
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
