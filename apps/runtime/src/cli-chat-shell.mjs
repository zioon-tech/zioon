import { CHAT_COMMANDS } from "./cli-input.mjs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { completeFilePath, localPath, readTextAttachment } from "./cli-files.mjs";
import { cacheImage, clipboardImage, droppedImagePaths, imageCapability, imageLabel, MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES, messageText, openImage, readCachedImage, readImageAttachment } from "./cli-images.mjs";
import { createActivity, createAnswerRenderer, safeText, terminalTheme, truncate } from "./cli-terminal.mjs";
import { createActivityFeed, printToolDetail, toolLabel, toolTarget } from "./cli-activity-feed.mjs";

export function friendlyCliError(error) {
  const message = safeText(error?.message || String(error));
  if (error?.name === "AbortError") return `Cancelled.${error.runId ? ` Reconnect with: zioon attach ${safeText(error.runId)}` : ""}`;
  if (error?.statusCode === 401 || /unauthorized|not authenticated|login required/i.test(message))
    return `${message}\nSign in with: zioon auth login`;
  if (error?.statusCode === 409 || /active Run/i.test(message))
    return `${message}\nUse /attach to follow the conversation's active Run.`;
  if ([429, 503].includes(error?.statusCode)) return `${message}\nService busy. Your draft is retained; check /recover before retrying.`;
  if (error?.statusCode === 403) return `${message}\nThis account cannot perform the action. Check /status and your account access.`;
  if (/fetch failed|ECONN|ENOTFOUND|TimeoutError|timed out|timeout/i.test(`${error?.name} ${message}`))
    return `${message}\nCheck your connection. Use /attach to check an accepted Run before sending again.`;
  return message;
}

export async function runChatShell({
  client, session: initialSession, sessionOptions, baseUrl, composer, output,
  environment = process.env, signal, requestedSessionId, state, defaults = {}, modelSource = "Runtime", initialImages = []
}) {
  let session = initialSession, activeRunId = "", lastRunId = "", stopping = false;
  let followController = null, abortTask = null, commandController = null;
  let sending = false, cancelAfterSend = false;
  let local = {}, draftTimer, connection = "Ready", modelCatalog;
  let tools = [], lastEventAt = 0, liveFeed;
  const cursors = new Map();
  const theme = terminalTheme(output, environment);
  if (!composer.rich) theme.interactive = false;
  const activity = createActivity(output, theme, { detailShortcut: true });
  const write = (text) => output.write(safeText(text));
  const toggleDetails = async () => {
    defaults.toolDetails = !defaults.toolDetails;
    liveFeed?.setExpanded(defaults.toolDetails);
    if (composer.active) {
      composer.erase();
      write(`Tool details: ${defaults.toolDetails ? "expanded" : "compact"} · Ctrl+O toggles\n`);
      if (defaults.toolDetails) for (const tool of tools.slice(-8)) printToolDetail(output, theme, tool);
      if (defaults.toolDetails && tools.length > 8) write("Earlier calls: /tools\n");
      composer.render();
    }
    await state?.write("settings", defaults);
  };
  composer.onDetails = () => { void toggleDetails().catch((error) => { composer.notice = friendlyCliError(error); composer.scheduleRender(); }); };
  const showCompression = (result) => {
    if (!result) { write("No compression checkpoint yet.\n"); return; }
    const status = typeof result.status === "object" ? result.status : result;
    write(`Compression: ${status.status || "unknown"}${status.mode ? ` · ${status.mode}` : ""}\n`);
    if (Number.isFinite(status.initialTokens) && Number.isFinite(status.finalTokens))
      write(`Context: ${status.initialTokens} → ${status.finalTokens} tokens · ${status.savedTokens ?? status.initialTokens - status.finalTokens} tokens saved\n`);
    if (status.window) write(`Model window: ${status.window} · input budget: ${status.budget ?? "unknown"} · output reserve: ${status.outputReserve ?? "unknown"} tokens\n`);
    if (status.error) write(`${status.error}\n`);
  };
  let draftKey = "session:new";
  const recordKey = () => session.id ? `session:${session.id}` : draftKey;
  const save = async (patch = {}, required = false) => {
    local = { ...local, ...patch };
    composer.images = local.images || [];
    if (await state?.write(recordKey(), local) === false && required) throw new Error("Cannot persist recovery state. Check disk space and permissions before sending.");
  };
  const draftSnapshot = () => ({ draft: composer.text || local.draft || "", history: composer.history || [],
    lastRunId, cursors: Object.fromEntries(cursors) });
  const flushDraft = async () => { clearTimeout(draftTimer); await save(draftSnapshot()); };
  const restore = async () => {
    if (!session.id && draftKey === "session:new") {
      const unopened = await state?.read("unopened");
      if (/^session:draft-[\w-]+$/.test(unopened?.key || "")) draftKey = unopened.key;
    }
    local = await state?.read(recordKey()) || {};
    if (!session.id && !session.model && local.draftModel) session.model = local.draftModel;
    composer.images = local.images || [];
    lastRunId = local.lastRunId || ""; cursors.clear();
    for (const [id, sequence] of Object.entries(local.cursors || {})) cursors.set(id, sequence);
    composer.history = local.history || []; composer.historyIndex = composer.history.length;
    composer.setDraft?.(composer.text || local.draft || "");
    if (session.id) await state?.write("last", { sessionId: session.id });
    if (local.draft || local.images?.length) write(`Draft restored${local.images?.length ? ` · ${local.images.length} image(s)` : ""} · /draft to inspect or clear.\n`);
    if (local.pending) write("A previous send needs checking · /recover before sending again.\n");
    if (local.failedSend) write("A failed Run has a saved draft · /recover draft restores its text and images.\n");
  };
  composer.onDraft = (text) => {
    local.draft = text;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void save(draftSnapshot()), 150);
  };
  const transcript = () => local.branchHistory ? Promise.resolve(local.branchHistory) :
    session.id ? client.getTranscript(session.id) : Promise.resolve([]);
  const switchSession = async (next) => {
    await flushDraft(); session = next; tools = []; modelSource = next.id ? "saved conversation" : "new conversation";
    if (!next.id) {
      draftKey = `session:draft-${randomUUID()}`;
      await state?.write("unopened", { key: draftKey });
    }
    if (composer.text !== undefined) composer.text = "";
    await restore(); announce();
  };
  const getModels = async () => modelCatalog = await client.models();
  const unavailable = (model) => model.available === false || model.configured === false || model.credentialAvailable === false ||
    model.credentialRequired && model.credentialConfigured === false;
  const addImages = async (paths) => {
    if (local.pending) throw new Error("Resolve the pending send with /recover before changing its images.");
    const added = paths
      ? await (async () => {
        const files = [];
        for (const path of paths) files.push(await readImageAttachment(path, state));
        return files;
      })()
      : [await cacheImage(await clipboardImage({ environment }), `clipboard-${Date.now()}.png`, state)];
    const images = [...local.images || []];
    for (const image of added) if (!images.some((item) => item.sha256 === image.sha256)) images.push(image);
    if (images.length > MAX_IMAGES || images.reduce((sum, image) => sum + image.byteLength, 0) > MAX_TOTAL_IMAGE_BYTES)
      throw new Error("Use at most 8 images and 32 MiB total per message. /images remove <number> frees space.");
    await save({ images }, true);
  };
  composer.onImages = addImages;
  composer.onImageAction = async (value) => {
    const [action, number] = value.split(" "), index = Number(number) - 1;
    if (!Number.isInteger(index) || !local.images?.[index]) throw new Error("Image no longer exists.");
    if (action === "open") await openImage(local.images[index], state);
    else if (action === "remove") {
      if (local.pending) throw new Error("Resolve the pending send with /recover before changing its images.");
      await save({ images: local.images.filter((_, n) => n !== index) }, true);
    }
  };
  const useModel = async (id, asDefault) => {
    const models = await getModels(), profile = models.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("Unknown model. Use /model to list configured models.");
    if (unavailable(profile)) throw new Error("Model is unavailable. Configure its credentials in Runtime settings.");
    if (asDefault) {
      defaults.modelProfileId = id; await state?.write("settings", defaults);
      write(`Default for future conversations: ${id}. Current conversation unchanged.\n`);
    } else {
      if (session.id && !local.branchHistory) session = await client.updateSession(session.id, { model: { profileId: id } });
      else session.model = { profileId: id };
      await save({ draftModel: session.model, ...(local.branchHistory ? { branchSession: session } : {}) });
      modelSource = "conversation selection";
      write(`Current model: ${id}\n`);
    }
  };
  const announce = () => {
    output.write(`\n  ${theme.bold("zioon")} ${theme.dim(" / ")} ${theme.bold(truncate(session.title || "Conversation", 60))}\n`);
    output.write(`  ${theme.dim(`${baseUrl} · ${session.model?.profileId || sessionOptions.model?.profileId || "default model"}`)}\n`);
    output.write(`  ${theme.dim(session.id ? `Session: ${session.id}` : "New conversation · created on first send")}\n`);
    output.write(`  ${theme.dim("/help commands · Ctrl+V image (/paste fallback) · Alt+I attachments")}\n\n`);
  };
  const stop = () => {
    if (commandController) { commandController.abort(new DOMException("Cancelled", "AbortError")); return; }
    if (sending && !activeRunId) { cancelAfterSend = true; activity.update("Stopping after acceptance"); return; }
    if (!activeRunId || stopping) return;
    stopping = true;
    activity.update("Stopping");
    abortTask = client.abortRun(activeRunId).then(() => {
      followController?.abort(new DOMException("Run stop requested", "AbortError"));
    }).catch((error) => {
      activity.stop(); write(`\nCould not stop: ${friendlyCliError(error)}\n`);
    }).finally(() => { stopping = false; });
  };
  composer.onCancel = stop;
  const detach = () => {
    followController?.abort(signal.reason);
    commandController?.abort(signal.reason);
    composer.close?.();
    composer.deliver(null);
  };
  signal?.addEventListener("abort", detach);
  const showHistory = async (limit = 0) => {
    const messages = await transcript();
    const visible = limit ? messages.slice(-limit) : messages;
    if (!visible.length) write("No messages yet.\n");
    for (const message of visible) {
      output.write(`${theme.bold(`${messages.indexOf(message) + 1} · ${message.role === "user" ? "you" : message.role || "zioon"}`)}\n`);
      const renderer = createAnswerRenderer(output, theme);
      renderer.write(messageText(message.content));
      renderer.end(); write("\n");
    }
    if (limit && messages.length > limit) write("Showing the latest messages. /history shows the full transcript.\n\n");
  };
  const follow = async (runId) => {
    if (!runId) throw new Error("Runtime did not return a Run ID");
    activeRunId = runId; lastRunId = runId;
    await save({ lastRunId });
    followController = new AbortController();
    const started = Date.now();
    lastEventAt = started; connection = "Thinking";
    let received = false, cursorTimer;
    const renderer = createAnswerRenderer(output, theme);
    const feed = liveFeed = createActivityFeed(output, theme, {
      activity, expanded: defaults.toolDetails, boundary: () => renderer.end(),
      onTool: (tool) => { tools.push(tool); tools = tools.slice(-100); }
    });
    activity.start("Thinking");
    if (cancelAfterSend) { cancelAfterSend = false; stop(); }
    const watchdog = setInterval(() => {
      if (Date.now() - lastEventAt > 30_000 && connection !== "Waiting for activity") {
        connection = "Waiting for activity"; renderer.end();
        activity.start("No new activity · Esc stop · Ctrl+C stop");
      }
    }, 1000);
    watchdog.unref?.();
    try {
      const run = await client.followRun(runId, (delta, event) => {
        connection = "Receiving";
        feed.beforeAnswer(event);
        if (!received) { output.write(`${theme.bold("zioon")}\n`); received = true; }
        renderer.write(delta);
      }, {
        signal: signal ? AbortSignal.any([signal, followController.signal]) : followController.signal,
        afterSequence: cursors.get(runId) || 0,
        reasoningMode: "summary",
        onConnection: (value) => { connection = value; renderer.end(); activity.start(`${value} · Run ${runId}`); },
        onEvent(event) {
          lastEventAt = Date.now();
          cursors.set(runId, event.sequence);
          if (state && !cursorTimer) cursorTimer = setTimeout(() => {
            cursorTimer = null; void save({ cursors: Object.fromEntries(cursors) });
          }, 500);
          if (cursors.size > 100) cursors.delete(cursors.keys().next().value);
          feed.event(event);
        }
      });
      activity.stop(); renderer.end(); feed.finish(run.status);
      if (run.usage) await save({ usage: run.usage });
      if (run.status !== "completed") {
        write(`[${run.status}] ${run.waiting?.reason || run.error?.message || run.error || run.terminalReason || ""}\n`);
        if (run.status === "waiting") write(`/resume ${runId} <JSON response> to respond, or zioon abort ${runId} to stop.\n`);
        if (run.status === "failed" && local.lastSubmission?.runId === runId) {
          await save({ failedSend: local.lastSubmission });
          write("Run failed. /recover draft restores its text and images; /model changes the model before resending.\n");
        }
        if (run.status === "interrupted") write(`/resume ${runId} to continue.\n`);
      }
      output.write(theme.dim(`  ${run.status} · ${((Date.now() - started) / 1000).toFixed(1)}s${feed.count ? ` · ${feed.count} tool${feed.count === 1 ? "" : "s"}` : ""}\n\n`));
      return run;
    } catch (error) {
      activity.stop(); renderer.end(); feed.finish();
      if (followController.signal.aborted && !signal?.aborted) {
        try {
          const stopped = await client.getRun(runId);
          write(["completed", "failed", "aborted", "interrupted"].includes(stopped.status)
            ? `[${stopped.status}] ${stopped.terminalReason || ""}\n\n`
            : `Stop requested. /attach ${runId} checks the final status.\n\n`);
        } catch { write(`Stop requested. /attach ${runId} checks the final status.\n\n`); }
      } else {
        write(`\n${friendlyCliError(error)}\n/attach ${runId} to reconnect.\n\n`);
      }
    } finally {
      clearInterval(watchdog); connection = "Ready";
      clearTimeout(cursorTimer);
      await abortTask; abortTask = null;
      activity.stop(); liveFeed = null; activeRunId = ""; followController = null;
      await save({ cursors: Object.fromEntries(cursors) });
    }
  };
  const reconcile = async () => {
    if (!local.pending) { write("No uncertain send.\n"); return true; }
    let messages;
    try { messages = await client.getTranscript(session.id); }
    catch (error) {
      if (error.statusCode === 404 && local.pending.branch) {
        write("Branch Session has not appeared on Runtime. The original history remains staged locally. Use /recover discard only after checking the connection.\n");
        return false;
      }
      throw error;
    }
    const pending = local.pending;
    const found = messages.find((message) => message.clientRequestId === pending.id) ||
      (pending.branch && messages.find((message) => message.role === "user" && message.runId && JSON.stringify(message.content) === JSON.stringify(pending.content)));
    if (found) {
      const runId = found.runId || (await client.getActiveRun(session.id))?.runId;
      await save({ pending: null, branchHistory: null, attachments: [], images: [],
        lastSubmission: { ...pending, runId } });
      write("The previous message was accepted. It will not be sent again.\n");
      if (runId) await follow(runId);
      return true;
    }
    write(`Acceptance is still unconfirmed. Draft retained.\n/recover retry reuses the same request ID${pending.branch ? " (unavailable for a seeded branch)" : ""}; /recover discard clears the local pending send.\n`);
    return false;
  };
  const send = async (content, retry = false) => {
    if (local.pending && !retry) {
      composer.setDraft?.(content); await save({ draft: content });
      write("Resolve the previous send with /recover first. New draft retained.\n"); return;
    }
    let pending = local.pending;
    if (pending && Array.isArray(pending.content) && pending.content.some((part) => part.type === "image_url")) {
      const catalog = await getModels();
      const profile = catalog.profiles.find((item) => item.id === (session.model?.profileId || catalog.activeProfileId));
      if (!imageCapability(profile) || unavailable(profile || {}))
        throw new Error("Select an available image model with /model before /recover retry. Pending text and images retained.");
    }
    if (!pending) {
      const attachments = local.attachments || [];
      await save({ draft: content, draftModel: session.model }, true);
      let images = local.images || [];
      if (images.length) {
        const catalog = await getModels();
        let id = session.model?.profileId || sessionOptions.model?.profileId;
        // Pick an explicit model for image sends so an interaction profile's
        // implicit default cannot silently route images to a text-only model.
        if (!id) id = catalog.activeProfileId;
        const profile = catalog.profiles.find((item) => item.id === id);
        if (!imageCapability(profile) || unavailable(profile || {})) {
          const compatible = catalog.profiles.filter((item) => imageCapability(item) && !unavailable(item));
          write("This model does not declare image support. Text and images are retained.\n");
          const chosen = composer.rich && compatible.length
            ? await composer.choose(compatible.map((item) => ({ id: item.id, label: `${item.label || item.id} · supports images` }))) : null;
          if (!chosen) throw new Error(`Choose an image model with /model${compatible.length ? ` (${compatible.map((item) => item.id).join(", ")})` : "; configure image support in Runtime first"}. Draft retained.`);
          await useModel(chosen, false);
        } else if (!session.model?.profileId) await useModel(id, false);
        commandController = new AbortController();
        try {
          for (let index = 0; index < images.length; index++) {
            if (images[index].uri) continue;
            const image = images[index];
            activity.start(`Uploading Image ${index + 1}/${images.length} · ${image.name}`);
            composer.images = images.map((item, n) => n === index ? { ...item, status: "uploading" } : item);
            try {
              const asset = await client.uploadImage(image, await readCachedImage(image, state), commandController.signal);
              if (!/^zion-asset:\/\/[a-zA-Z0-9._:-]{1,200}$/.test(asset?.uri || "") || asset.state !== "ready")
                throw new Error("Upload did not return a ready image. Draft retained.");
              images = images.map((item, n) => n === index ? { ...item, uri: asset.uri, status: "uploaded" } : item);
              await save({ images }, true);
            } catch (error) {
              images = images.map((item, n) => n === index ? { ...item, status: "upload failed" } : item);
              await save({ images });
              throw error;
            }
          }
        } finally { commandController = null; activity.stop(); composer.images = local.images || []; }
      }
      const text = attachments.length ? `${content}\n\n${attachments.map((file) => `<attached-file name=${JSON.stringify(file.name)}>\n${file.content}\n</attached-file>`).join("\n\n")}` : content;
      const payload = images.length ? [
        ...(text ? [{ type: "text", text }] : []),
        ...images.flatMap((image, index) => [{ type: "text", text: `[Image ${index + 1}]` }, { type: "image_url", image_url: { url: image.uri } }])
      ] : text;
      if (!session.id) {
        const oldKey = recordKey();
        const created = await client.createSession({ ...sessionOptions, model: session.model || sessionOptions.model, title: session.title });
        session = created; await save();
        await state?.write(oldKey, { draft: "", draftModel: null, attachments: [], images: [], pending: null });
        await state?.write("last", { sessionId: session.id });
        write(`Session: ${session.id}\n`);
      }
      pending = { id: randomUUID(), content: payload, draft: content, images, attachments, branch: Boolean(local.branchHistory), status: "unconfirmed" };
      await save({ pending, draft: "" }, true);
    }
    if (retry && pending.branch) throw new Error("Seeded branch sends cannot be retried safely. Use /recover to check it, or /open its Session after recovery.");
    activity.start("Sending"); sending = true; connection = "Sending";
    try {
      const accepted = pending.branch
        ? await client.startBranch(session.id, local.branchHistory, pending.content, {
          ...sessionOptions, model: session.model, title: session.title,
          policy: session.policy || sessionOptions.policy, projectId: session.projectId || sessionOptions.projectId,
          metadata: { ...sessionOptions.metadata, ...session.metadata }
        })
        : await client.sendMessage(session.id, pending.content, pending.id);
      if (!accepted.runId) throw new Error("Runtime did not return a Run ID; acceptance is unconfirmed");
      await save({ pending: null, branchHistory: null, attachments: [], images: [], lastRunId: accepted.runId,
        lastSubmission: { ...pending, runId: accepted.runId }, failedSend: null });
      sending = false; activity.stop();
      await follow(accepted.runId);
    } catch (error) {
      if (local.pending) {
        const rejected = [400, 401, 403, 404, 422, 429].includes(error.statusCode);
        await save({ pending: { ...pending, status: rejected ? "not-sent" : "unconfirmed" } });
        write(rejected ? "Not sent. Draft saved · /recover retry when ready.\n" : "Acceptance unconfirmed. Draft saved · /recover before retrying.\n");
      }
      throw error;
    } finally { sending = false; connection = "Ready"; activity.stop(); }
  };
  if (state) await restore();
  if (initialImages.length) await addImages(initialImages);
  announce();
  try {
    if (requestedSessionId && composer.rich) {
      try {
        await showHistory(6);
        const active = await client.getActiveRun(session.id);
        if (active?.id || active?.runId) write(`Active Run: ${active.id || active.runId} · /attach to follow\n\n`);
      } catch (error) { write(`${friendlyCliError(error)}\n`); }
    }
    while (!signal?.aborted) {
      const line = await composer.read();
      await composer.attachmentTask;
      if (line === null) break;
      let content = line.trim();
      if (!content && !local.images?.length) continue;
      if (content === "/exit" || content === "/quit") break;
      const command = content.match(/^\S+/)?.[0] || "";
      const arg = content.slice(command.length).trim(), parts = arg.split(/\s+/);
      try {
        if (command === "/help") {
          for (const [name, description] of CHAT_COMMANDS) write(`  ${name.padEnd(12)} ${description}\n`);
          write("\nEnter sends · Alt+Enter / Ctrl+J inserts a newline · \\ + Enter continues\nTab opens commands, ↑↓ selects, Tab fills · Ctrl+R searches input history\nCtrl+G opens VISUAL/EDITOR · /file <path> attaches text; Tab completes paths\nCtrl+V / Alt+V or /paste imports a clipboard image · drag image files to attach\n/image <path> adds images · /images open|remove <number> manages them\nPNG/JPEG/GIF/WebP/AVIF · 16 MiB each · 8 images / 32 MiB total\nCtrl+A/E line start/end · Ctrl+W delete word\nEsc stops a Run · Ctrl+C clears a draft, stops a Run, or exits when empty\nCtrl+D exits when empty · Bracketed paste keeps multiple lines together\n\n");
        } else if (command === "/session") {
          write(session.id ? `${session.id}\nzioon chat --session ${session.id}\n\n` : "New conversation · sends will create a Session.\n");
        } else if (command === "/status") {
          write(`Endpoint: ${baseUrl}\nConnection: ${connection}\nSession: ${session.id || "new"}\nModel: ${session.model?.profileId || sessionOptions.model?.profileId || "default"} (${modelSource})\nLast Run: ${lastRunId || "none"}\nPending send: ${local.pending?.status || "none"}\n\n`);
        } else if (command === "/model") {
          if (arg) {
            const [first, second] = parts;
            await useModel(first === "default" ? second : first, first === "default");
          } else {
            const catalog = await getModels();
            const items = catalog.profiles.map((model) => ({ id: model.id, label: `${model.label || model.id}${model.id === (session.model?.profileId || catalog.activeProfileId) ? " · current" : ""} · ${unavailable(model) ? "unavailable" : "configured"}${imageCapability(model) ? " · images" : ""}${model.providerId ? ` · ${model.providerId}` : ""}` }));
            write("Model configuration comes from Runtime; availability is configuration status, not a live provider probe.\n");
            if (composer.rich) {
              const id = await composer.choose(items);
              if (id) await useModel(id, false);
            } else for (const item of items) write(`${item.id}  ${item.label}\n`);
          }
        } else if (command === "/settings") {
          write(`Model: ${session.model?.profileId || sessionOptions.model?.profileId || "Runtime default"}\nSource: ${modelSource}\nDefault for future chats: ${defaults.modelProfileId || "Runtime"}\nLocal recovery: ${state?.root || "disabled"}\nTool details: ${defaults.toolDetails ? "expanded" : "compact"}\n`);
          let setting = arg;
          if (!setting && composer.rich) setting = await composer.choose([
            { id: "tools", label: "Toggle expanded tool details" }, { id: "default", label: "Choose default model for future conversations" },
            { id: "reset-model", label: "Reset local model default to Runtime" }
          ]);
          if (setting === "tools") { await toggleDetails(); write(`Tool details: ${defaults.toolDetails ? "expanded" : "compact"}\n`); }
          if (setting === "reset-model") { defaults.modelProfileId = ""; await state?.write("settings", defaults); write("Future chats use the Runtime default unless flags or environment override it.\n"); }
          if (setting === "default") {
            const catalog = await getModels();
            const id = await composer.choose(catalog.profiles.map((item) => ({ id: item.id, label: item.label || item.id })));
            if (id) await useModel(id, true);
          }
        } else if (command === "/details") {
          await toggleDetails(); write(`Tool details: ${defaults.toolDetails ? "expanded" : "compact"}\n`);
        } else if (command === "/tools") {
          if (arg && arg !== "all" && (!/^[1-9]\d*$/.test(arg) || Number(arg) > tools.length)) throw new Error("Use /tools, /tools <number>, or /tools all.");
          if (!tools.length) write("No tool activity observed in this process yet. /attach can follow a Run.\n");
          for (const [index, tool] of tools.entries()) {
            if (arg && arg !== "all" && arg !== String(index + 1)) continue;
            write(`${index + 1}. ${toolLabel(tool)} (${tool.name})${toolTarget(tool) ? ` · ${toolTarget(tool)}` : ""} · ${tool.status}${tool.elapsedMs !== undefined ? ` · ${tool.elapsedMs}ms` : ""}\n`);
            if (arg === "all" || arg === String(index + 1)) write(`${JSON.stringify({ request: tool.request, result: tool.result }, null, 2)}\n`);
          }
          if (!arg && tools.length) write("/tools <number> or /tools all expands arguments and results.\n");
        } else if (command === "/context") {
          const messages = await transcript();
          const characters = messages.reduce((total, message) => total + JSON.stringify(message.content).length, 0);
          write(`${messages.length} messages · approximately ${Math.ceil(characters / 3)} transcript tokens (heuristic; excludes system prompt/tools).\n`);
          if (local.usage) write(`Last Run usage: input ${local.usage.inputTokens ?? "unknown"} · output ${local.usage.outputTokens ?? "unknown"} · cache read ${local.usage.cacheReadTokens ?? 0} tokens. These are cumulative Run usage, not remaining context capacity.\n`);
          if (session.id && !local.branchHistory) {
            try {
              const { result } = await client.compression(session.id, "status");
              showCompression(result);
            } catch (error) { write(`Compression status unavailable: ${friendlyCliError(error)}\n`); }
          }
        } else if (command === "/compact") {
          if (!session.id || local.branchHistory) throw new Error("Send a message before compacting this conversation.");
          if (arg !== "force") {
            const messages = await transcript();
            const estimate = Math.ceil(messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0) / 3);
            if (estimate < 1024) {
              write(`History is short (approximately ${estimate} tokens). Compression skipped; original context retained.\n/compact force requests compression anyway.\n`);
              continue;
            }
          }
          write("Compressing model context. Original transcript stays available through /history and /export.\nThe handoff retains recent messages and uncertain tool outcomes; use compressionRecall for retained tool output.\n");
          activity.start("Compressing");
          commandController = new AbortController();
          try {
            const { result } = await client.compression(session.id, "compact", commandController.signal);
            showCompression(result);
          } finally { commandController = null; activity.stop(); }
        } else if (command === "/search") {
          if (!arg) throw new Error("Usage: /search <text>");
          const messages = await transcript();
          const matches = messages.map((message, index) => ({ message, index })).filter(({ message }) => JSON.stringify(message.content).toLowerCase().includes(arg.toLowerCase()));
          for (const { message, index } of matches) write(`${index + 1} · ${message.role}\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}\n\n`);
          if (!matches.length) write("No matching messages.\n");
        } else if (command === "/export") {
          if (!arg) throw new Error("Usage: /export <file.md|file.json>");
          const path = localPath(arg), messages = await transcript();
          const text = path.endsWith(".json") ? JSON.stringify({ session, messages }, null, 2) :
            `# ${session.title || "Conversation"}\n\n${messages.map((message, index) => `## ${index + 1} · ${message.role}\n\n${messageText(message.content)}`).join("\n\n")}\n`;
          await writeFile(path, text, { flag: "wx", mode: 0o600 });
          write(`Exported: ${path}\n`);
        } else if (command === "/image" || command === "/paste") {
          if (command === "/paste") await addImages(null);
          else {
            let path = arg;
            while (!path && composer.rich) {
              const options = await completeFilePath(`/image ${localPath(".")}/`);
              path = await composer.choose(options.map((item) => ({ ...item, id: item.id.slice(7) })));
              if (!path) break;
              while (/[/\\]$/.test(path)) {
                const children = await completeFilePath(`/image ${path}`);
                path = await composer.choose(children.map((item) => ({ ...item, id: item.id.slice(7) })));
                if (!path) break;
              }
              break;
            }
            if (!path) { write("Use /image <path>; Tab completes paths. Drag or paste image paths to attach.\n"); continue; }
            await addImages(droppedImagePaths(path) || [path]);
          }
          write(`${(local.images || []).map(imageLabel).join("\n")}\n`);
        } else if (command === "/images") {
          const [action, number] = parts, index = Number(number) - 1;
          if (action === "clear" || action === "remove") {
            if (local.pending) throw new Error("Resolve the pending send with /recover before changing its images.");
            if (action === "remove" && (!Number.isInteger(index) || !local.images?.[index])) throw new Error("Usage: /images remove <number>");
            await save({ images: action === "clear" ? [] : local.images.filter((_, n) => n !== index) });
          } else if (action === "open") {
            if (!Number.isInteger(index) || !local.images?.[index]) throw new Error("Usage: /images open <number>");
            await openImage(local.images[index], state);
          } else if (arg) throw new Error("Usage: /images [open|remove <number>|clear]");
          write(`${(local.images || []).map(imageLabel).join("\n") || "No images."}\n`);
        } else if (command === "/file") {
          if (local.pending) throw new Error("Resolve the pending send with /recover before changing attachments.");
          if (!arg) throw new Error("Usage: /file <UTF-8 text path>");
          const file = await readTextAttachment(arg), attachments = [...local.attachments || [], file];
          if (attachments.reduce((size, item) => size + Buffer.byteLength(item.content, "utf8"), 0) > 96 * 1024) throw new Error("Attachments exceed 96 KiB. /files clear to start again.");
          await save({ attachments }); write(`Attached ${file.name} (${file.content.length} characters) to the next message. /files clear removes it.\n`);
        } else if (command === "/files") {
          if (local.pending && arg === "clear") throw new Error("Resolve the pending send with /recover before changing attachments.");
          if (arg === "clear") await save({ attachments: [] });
          write((local.attachments || []).map((file) => `${file.name} · ${file.content.length} characters`).join("\n") || "No attachments.");
          write("\n");
        } else if (command === "/editor") {
          await composer.edit?.();
        } else if (command === "/draft") {
          if (arg === "clear") { composer.setDraft?.(""); await save({ draft: "" }); }
          else if (arg === "send" && (local.draft || local.images?.length)) { content = local.draft || ""; composer.setDraft?.(""); await send(content); }
          else write(`${local.draft || local.pending?.draft || "No saved draft."}\n`);
        } else if (command === "/recover") {
          if (arg === "draft") {
            if (local.pending) throw new Error("Check the pending send with /recover before restoring another draft.");
            const failed = local.failedSend || local.lastSubmission;
            if (!failed?.runId) throw new Error("No saved failed submission.");
            const run = await client.getRun(failed.runId);
            if (run.status !== "failed") throw new Error(`Run is ${run.status}; draft restoration is only available for failed Runs.`);
            await save({ draft: failed.draft || "", images: failed.images || [], attachments: failed.attachments || [] }, true);
            composer.setDraft?.(failed.draft || "");
            write("Failed Run draft restored. Change /model if needed, then send when ready.\n");
          } else if (arg === "discard") {
            const draft = local.pending?.draft || local.draft || "";
            await save({ pending: null, draft }); composer.setDraft?.(draft);
            write("Local pending send cleared; text and attachments restored. Any remotely accepted Run is unaffected; /attach checks it.\n");
          } else if (arg === "retry") {
            if (!local.pending) write("No pending send.\n");
            else await send(local.pending.content, true);
          } else await reconcile();
        } else if (command === "/fork") {
          if (!session.id) throw new Error("Start a conversation before branching.");
          if (local.pending) throw new Error("Resolve the pending send with /recover first.");
          if (!arg) {
            const result = await client.forkSession(session.id);
            await switchSession(result.session);
          } else {
            const messages = await transcript(), count = Number(arg);
            if (!Number.isInteger(count) || count < 1 || count > messages.length) throw new Error("Use /history, then /fork <message-number>.");
            const selected = messages.slice(0, count);
            const outstanding = new Set();
            for (const message of selected) {
              for (const call of message.toolCalls || []) outstanding.add(call.id);
              if (message.role === "tool") outstanding.delete(message.toolCallId);
            }
            if (outstanding.size) throw new Error("Choose a message after the tool results so the branch keeps complete tool calls.");
            const history = selected.map(({ role, content, toolCalls, toolCallId, toolResultStatus }) => ({
              role, content, ...(toolCalls ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}),
              ...(toolResultStatus ? { toolResultStatus } : {})
            }));
            const next = { ...session, id: `session_cli_${randomUUID()}`, title: `${session.title || "Conversation"} (branch at ${count})` };
            await switchSession(next);
            await save({ branchHistory: history, branchSession: next });
            write(`Branch prepared through message ${count}. The next message starts its own Run.\n`);
          }
        } else if (command === "/new") {
          await switchSession({ title: arg || sessionOptions.title, model: defaults.modelProfileId ? { profileId: defaults.modelProfileId } : sessionOptions.model });
        } else if (command === "/open" || command === "/sessions") {
          let id = arg;
          if (command === "/sessions") {
            const sessions = await client.listSessions(50);
            if (!sessions.length) { write("No conversations yet. /new starts one.\n"); continue; }
            if (composer.rich) {
              write("Search conversations\n");
              id = await composer.choose(sessions.map((item) => ({ id: item.id, label: item.title || "Untitled" })));
              if (!id) continue;
            } else {
              for (const item of sessions) write(`${item.id}  ${item.title || "Untitled"}\n`);
              write("/open <id> to switch.\n"); continue;
            }
          }
          if (!id) throw new Error("Usage: /open <session-id>");
          await switchSession(await client.getSession(id));
          await showHistory(6);
        } else if (command === "/history") {
          await showHistory();
        } else if (command === "/attach" || command === "/resume") {
          let runId = arg.split(/\s+/)[0];
          if (!runId && command === "/attach") {
            const active = session.id ? await client.getActiveRun(session.id) : null;
            runId = active?.id || active?.runId || lastRunId;
          }
          if (!runId) throw new Error(`Usage: ${command} <run-id>`);
          if (command === "/resume") {
            const current = await client.getRun(runId);
            const responseText = arg.slice(runId.length).trim();
            const result = await client.resumeRun(runId, {
              ...(current.waiting?.id ? { waitId: current.waiting.id } : {}),
              ...(responseText ? { input: JSON.parse(responseText) } : {})
            });
            runId = result.runId || result.run?.id || runId;
          }
          await follow(runId);
        } else if (droppedImagePaths(content)) {
          await addImages(droppedImagePaths(content));
          write(`${(local.images || []).map(imageLabel).join("\n")}\n`);
        } else if (command.startsWith("/")) {
          write(`Unknown command: ${command}. Type /help for available commands.\n`);
        } else {
          await send(content);
        }
      } catch (error) {
        if (!local.pending && local.draft && !composer.text && (!command.startsWith("/") || command === "/draft"))
          composer.setDraft?.(local.draft);
        cancelAfterSend = false;
        activity.stop(); write(`${friendlyCliError(error)}\n\n`);
      }
    }
  } finally {
    await flushDraft(); await state?.flush();
    composer.onDraft = () => {};
    composer.onImages = null;
    composer.onImageAction = null;
    activity.stop(); signal?.removeEventListener("abort", detach);
  }
  write(session.id ? `\nSaved in Session ${session.id}.\n` : "\nDraft saved locally. No conversation created.\n");
  return session;
}
