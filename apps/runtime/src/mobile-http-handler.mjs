import { Buffer } from "node:buffer";
import {
  contentText,
  deriveSessionTitleFromContent,
  isPlaceholderSessionTitle
} from "./session-title.mjs";

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function compact(value, max = 180) {
  const text = contentText(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function displayTitle(session, messages) {
  const title = String(session?.title || "").trim();
  if (!isPlaceholderSessionTitle(title, session?.id, session?.metadata)) return title;
  const firstUser = messages.find((message) => message?.role === "user");
  return deriveSessionTitleFromContent(firstUser?.content, 48) || "新会话";
}

export function createMobileHttpHandler({
  sessions,
  activeRunForSession,
  presentationForSession,
  allowedSessionIds = null
} = {}) {
  if (!sessions?.listSessions || !sessions?.getSessionMessages) {
    throw new Error("Mobile HTTP handler requires a Session store");
  }

  return async function handleMobile(request, response, url) {
    if (!url.pathname.startsWith("/v1/mobile/")) return false;

    if (request.method === "GET" && url.pathname === "/v1/mobile/sessions") {
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit")) || 50)
      );
      const offset = Math.max(
        0,
        Number(url.searchParams.get("offset")) || 0
      );
      const query = String(url.searchParams.get("query") || "")
        .trim()
        .toLowerCase();
      const records = await sessions.listSessions({
        limit: query ? 100 : limit,
        offset: query ? 0 : offset,
        ...(allowedSessionIds ? { allowedSessionIds: await allowedSessionIds(request.zionPrincipal) } : {})
      });
      const visibleRecords = records.filter((session) => (
        session?.metadata?.source !== "scheduled-task"
      ));
      const summaries = await Promise.all(visibleRecords.map(async (session) => {
        const [messages, presentation] = await Promise.all([
          sessions.getSessionMessages(session.id),
          presentationForSession?.(session.id) || null
        ]);
        const latest = messages.at(-1) || null;
        const activeRun = await activeRunForSession?.(session.id) || null;
        const presentationTitle = String(presentation?.title || "").trim();
        const presented = presentationTitle
          && !isPlaceholderSessionTitle(presentationTitle, session.id, presentation)
          ? { ...session, title: presentationTitle }
          : session;
        return {
          ...presented,
          title: displayTitle(presented, messages),
          lastMessage: latest
            ? {
                id: latest.id,
                sequence: latest.sequence,
                role: latest.role,
                content: compact(latest.content),
                runId: latest.runId,
                createdAt: latest.createdAt
              }
            : null,
          activeRun
        };
      }));
      const filtered = query
        ? summaries.filter((session) => (
            String(session.title || "").toLowerCase().includes(query)
            || String(session.lastMessage?.content || "")
              .toLowerCase()
              .includes(query)
          )).slice(offset, offset + limit)
        : summaries;
      json(response, 200, {
        sessions: filtered,
        offset,
        limit,
        nextOffset: filtered.length === limit ? offset + limit : null
      });
      return true;
    }

    json(response, 404, { error: "Mobile endpoint not found" });
    return true;
  };
}
