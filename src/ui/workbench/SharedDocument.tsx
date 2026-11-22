import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSpacesClient } from "../../../packages/runtime-client/src/spaces.mjs";
import { accountLoginUrl } from "../../../packages/account-ui/src/client";
import { readWorkbenchRuntimeConfig } from "../../runtime/workbench-runtime-config";
import { mountPublicReader, type PublicDocument } from "../../public-reader/reader";
import { setDisplayPreferenceViewer } from "../../editor/display-preferences";
import "../../public-reader/reader.css";
import "../../../extensions/dev.tools/styles.css";
import "../../../extensions/dev.thinking/styles.css";
import "katex/dist/katex.min.css";
import "./spaces-workbench.css";

export function sharedDocumentUrl(baseUrl: string, spaceId: string, documentId: string) {
  const url = new URL("/shared", baseUrl);
  url.searchParams.set("space", spaceId); url.searchParams.set("document", documentId);
  return url.toString();
}

export function AssetPreview({ baseUrl, spaceId, assetId, documentId }: { baseUrl: string; spaceId: string; assetId: string; documentId?: string }) {
  const [src, setSrc] = useState(""), [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = "";
    setSrc(""); setError(false);
    const path = documentId ? `/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetId)}`
      : `/v1/assets/${encodeURIComponent(assetId)}/content`;
    void fetch(`${baseUrl}${path}`, {
      headers: { "x-zioon-space-id": spaceId }, credentials: "include", signal: controller.signal, cache: "no-store"
    }).then(async response => {
      if (!response.ok || !/^image\/(?:png|jpeg|webp|gif|avif)(?:;|$)/i.test(response.headers.get("content-type") || "")) throw new Error("图片不可用");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setSrc(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [baseUrl, spaceId, assetId, documentId]);
  return src ? <img alt="文档图片" src={src} /> : <small>{error ? "图片不可用" : "读取图片…"}</small>;
}

export function SharedDocument({ baseUrl, spaceId, documentId }: { baseUrl: string; spaceId: string; documentId: string }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<any>(null), [comments, setComments] = useState<any[]>([]);
  const [error, setError] = useState(""), [login, setLogin] = useState(false), [body, setBody] = useState(""), [busy, setBusy] = useState(false);
  const actions = useRef<{ refresh(): Promise<void>; comment(text: string): Promise<void> } | null>(null);
  useEffect(() => {
    let disposed = false, request: AbortController | null = null, generation = 0;
    let reader: ReturnType<typeof mountPublicReader> | null = null, viewer = "";
    let latest: PublicDocument | { state: string } = { state: "unavailable" };
    const lifetime = new AbortController();
    setValue(null); setComments([]); setError(""); setLogin(false); setBody(""); setBusy(false);
    const path = `/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}`;
    const workbenchUrl = `${new URL(baseUrl).origin}/?${new URLSearchParams({ space: spaceId, session: documentId })}`;
    const refresh = async () => {
      request?.abort();
      const controller = new AbortController(), id = ++generation; request = controller;
      const api = createSpacesClient({ baseUrl, spaceId, signal: controller.signal });
      try {
        const identity = await createSpacesClient({ baseUrl, signal: controller.signal }).identity();
        if (!identity.authenticated || typeof identity.user?.id !== "string") throw Object.assign(new Error("login"), { status: 401 });
        if (disposed || id !== generation) return;
        if (viewer && viewer !== identity.user.id) { reader?.dispose(); reader = null; setValue(null); setComments([]); setBody(""); }
        viewer = identity.user.id;
        setDisplayPreferenceViewer(viewer, identity.space?.id);
        const commentResult = await api.document(documentId, "comments");
        const next = await api.document(documentId);
        if (disposed || controller.signal.aborted || id !== generation) return;
        const document: PublicDocument = next.reader || { state: "read", title: next.content.title,
          markdown: next.content.text, cards: next.content.cards || { tools: [], thinking: [] },
          mode: "restricted", role: next.access.role, contentRevision: String(next.content.revision) };
        latest = document;
        if (!reader) reader = mountPublicReader(canvas.current!, document, { path, workbenchUrl,
          presence: { url: `${new URL(baseUrl).origin}${path}/presence`, headers: { "x-zioon-space-id": spaceId },
            onAccessLost: () => { void refresh(); } },
          refresh: async () => { await refresh(); return disposed ? { state: "unavailable" } : latest; },
          refreshMs: 15000, imageUrl: source => /^zion-asset:\/\/[A-Za-z0-9_-]{1,256}$/.test(source)
            ? `${new URL(baseUrl).origin}${path}/assets/${source.slice(13)}` : null });
        else reader.update(document);
        setValue(next); setComments(commentResult.comments || []); setLogin(false); setError("");
      } catch (cause: any) {
        if (disposed || controller.signal.aborted || id !== generation) return;
        if ([401, 403, 404].includes(cause.status)) {
          latest = { state: "unavailable" };
          reader?.dispose(); reader = null; setValue(null); setComments([]); setBody("");
        }
        setLogin(cause.status === 401);
        setError(cause.status === 401 ? "请登录后查看分享给你的文档。" : [403, 404].includes(cause.status)
          ? "文档不可用，或尚未分享给当前账号。" : "暂时无法读取文档，请稍后刷新。");
      }
    };
    const comment = async (text: string) => {
      const id = generation; setBusy(true);
      try {
        await createSpacesClient({ baseUrl, spaceId, signal: lifetime.signal }).mutateDocument(documentId, "comments", "POST", { body: text });
        if (disposed || id !== generation) return;
        setBody(""); await refresh();
      } catch (cause: any) {
        if (!disposed && id === generation) { setError(cause.message); if ([401, 403, 404].includes(cause.status)) await refresh(); }
      } finally { if (!disposed) setBusy(false); }
    };
    actions.current = { refresh, comment }; void refresh();
    return () => { disposed = true; generation++; request?.abort(); lifetime.abort(); reader?.dispose(); actions.current = null; };
  }, [baseUrl, spaceId, documentId]);
  return <main className="zs-shared-reader public-reader">
    {error && <section className="zs-reader-status"><p role="alert">{error}</p>{login && <a href={accountLoginUrl(baseUrl, location.pathname + location.search)}>登录并继续</a>}
      <button onClick={() => void actions.current?.refresh()}>刷新</button></section>}
    <div className="zs-shared-panel" ref={canvas} />
    {value && <section className="zs-reader-comments">
      <p className="zs-reader-meta">权限：{value.access.role === "commenter" ? "可评论" : value.access.role === "viewer" ? "可查看" : "可协作"} · 最新版本 {value.content.revision}</p>
      <details><summary>评论 · {comments.length}</summary>{comments.map(comment => <div key={comment.id}><strong>{comment.authorName}</strong><small>{new Date(comment.createdAt).toLocaleString("zh-CN")}</small><p>{comment.body}</p></div>)}
        {["commenter", "editor", "manager"].includes(value.access.role) && <form onSubmit={event => {
          event.preventDefault(); void actions.current?.comment(body);
        }}><label>添加评论<textarea required maxLength={8000} value={body} onChange={event => setBody(event.target.value)} /></label><button disabled={busy}>{busy ? "添加中…" : "添加评论"}</button></form>}
      </details>
    </section>}
  </main>;
}

export function mountSharedDocument(host: HTMLElement) {
  if (location.pathname !== "/shared") return false;
  const query = new URLSearchParams(location.search), spaceId = query.get("space"), documentId = query.get("document");
  if (!spaceId || !documentId) { host.textContent = "文档链接不完整。"; return true; }
  const baseUrl = readWorkbenchRuntimeConfig().baseUrl;
  const root = createRoot(host); root.render(<SharedDocument baseUrl={baseUrl} spaceId={spaceId} documentId={documentId} />);
  return true;
}
