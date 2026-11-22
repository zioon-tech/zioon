import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronRight, Folder, X } from "lucide-react";
import type { DocumentParticipant } from "../../../packages/runtime-client/src/sharing.mjs";
import "./editor-participants.css";
export type HeaderParticipant = Omit<DocumentParticipant, "role"> & { role: string; visitor?: boolean };
export type ParticipantsSnapshot = { scopeKey: string; people: HeaderParticipant[]; canManage?: boolean };
export type ParticipantsSource = {
  snapshot(): ParticipantsSnapshot;
  subscribe(listener: () => void): { dispose(): void };
};
type ParticipantActions = {
  onUpdate(person: HeaderParticipant, role: "viewer" | "editor" | "removed"): Promise<void>;
  onManage(grant?: NonNullable<DocumentParticipant["grants"]>[number]): void;
};
export function createParticipantsHeader(header: HTMLElement) {
  const host = document.createElement("span"); host.className = "editor-participants-host";
  header.insertBefore(host, header.querySelector("[data-zion-editor-session-rename-button='1']"));
  const root = createRoot(host);
  let disposed = false;
  return {
    render(snapshot: ParticipantsSnapshot, actions?: ParticipantActions) {
      if (disposed) return;
      root.render(<Participants key={snapshot.scopeKey} people={snapshot.people} header={header}
        canManage={!!snapshot.canManage && !!actions}
        onUpdate={actions?.onUpdate || (async () => { throw new Error("仅可阅读"); })}
        onManage={actions?.onManage || (() => {})} />);
    },
    dispose() { if (!disposed) { disposed = true; host.remove(); queueMicrotask(() => root.unmount()); } }
  };
}
export function mountParticipantsHeader(header: HTMLElement, source: ParticipantsSource) {
  const view = createParticipantsHeader(header);
  const render = () => view.render(source.snapshot());
  const subscription = source.subscribe(render); render();
  return { dispose() { subscription.dispose(); view.dispose(); } };
}
const roleName: Record<string, string> = { owner: "所有者", editor: "可编辑", viewer: "可查看", commenter: "可评论", manager: "可管理", visitor: "访客" };
const presenceName = (person: HeaderParticipant) => person.online === true ? "正在此文档中"
  : person.online === false ? "当前未在此文档中" : "在线状态暂不可用";
const displayName = (person: HeaderParticipant) => person.name.trim() || "未命名用户";
const CARD_WIDTH = 256;
export function participantInitial(name: string) {
  const parts = name.trim().split(/\s+/u);
  if (!parts[0]) return "?";
  return (/^[a-z]/i.test(parts[0]) && parts.length > 1
    ? Array.from(parts[0])[0] + Array.from(parts.at(-1)!)[0]
    : Array.from(parts[0]).slice(0, /^[a-z]/i.test(parts[0]) ? 2 : 1).join("")).toLocaleUpperCase();
}
function Avatar({ person }: { person: HeaderParticipant }) {
  let hash = 0;
  for (const char of person.id) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return <span aria-hidden="true" className={`editor-participant-avatar tone-${Math.abs(hash % 4)}`}
    data-online={String(person.online)}>
    {participantInitial(displayName(person))}
    {person.online === true && <i className="editor-participant-online" />}
  </span>;
}

export function Participants({ people, header, canManage, onUpdate, onManage }: { people: HeaderParticipant[]; header: HTMLElement;
  canManage: boolean; onUpdate(person: HeaderParticipant, role: "viewer" | "editor" | "removed"): Promise<void>;
  onManage(grant?: NonNullable<HeaderParticipant["grants"]>[number]): void }) {
  const [opened, setOpened] = useState<{ id: string; pinned: boolean; anchor: HTMLElement } | null>(null);
  const [limit, setLimit] = useState(4);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const card = useRef<HTMLElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const popoverId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<HeaderParticipant | null>(null);
  const person = people.find(person => person.id === opened?.id);
  const shown = opened && (person || opened.id === "all") ? opened : null;
  function cancelTimers() { clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); }
  function close(restoreFocus = false) {
    cancelTimers(); setOpened(null); setConfirm(null); setError(""); setNotice("");
    if (restoreFocus && opened?.anchor.isConnected) opened.anchor.focus({ preventScroll: true });
  }
  function hover(id: string, anchor: HTMLElement) {
    cancelTimers();
    if (opened?.pinned) return;
    hoverTimer.current = setTimeout(() => setOpened({ id, anchor, pinned: false }), 160);
  }
  function leave() {
    clearTimeout(hoverTimer.current);
    if (!opened?.pinned) closeTimer.current = setTimeout(() => setOpened(null), 180);
  }
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width || 0;
      setLimit(width < 340 ? 1 : width < 480 ? 2 : 4);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [header]);
  useEffect(() => () => cancelTimers(), []);
  useLayoutEffect(() => {
    if (opened && (!opened.anchor.isConnected || opened.id !== "all" && !person)) close();
  }, [opened, people, limit]);
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const rect = shown.anchor.getBoundingClientRect();
      const width = Math.min(CARD_WIDTH, Math.max(0, window.innerWidth - 16));
      const height = card.current?.getBoundingClientRect().height || 120;
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.bottom + 7, window.innerHeight - height - 8))
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [shown?.id, shown?.anchor, shown?.pinned, people, canManage, error, confirm, notice]);
  useEffect(() => {
    if (!shown) return;
    if (shown.pinned) card.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!card.current?.contains(target) && !header.querySelector(".editor-participants")?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(shown.pinned); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("focusin", outside);
    };
  }, [shown?.id, shown?.anchor, shown?.pinned]);
  if (!people.length) return null;
  const update = async (person: HeaderParticipant, role: "viewer" | "editor" | "removed") => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await onUpdate(person, role); setConfirm(null); setNotice("权限已更新。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  function buttonProps(id: string) {
    return {
      onMouseEnter: (event: React.MouseEvent<HTMLButtonElement>) => hover(id, event.currentTarget),
      onMouseLeave: leave,
      onFocus: (event: React.FocusEvent<HTMLButtonElement>) => hover(id, event.currentTarget),
      onBlur: () => { if (!opened?.pinned) close(); },
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        cancelTimers();
        setConfirm(null); setError(""); setNotice("");
        setOpened(opened?.id === id && opened.pinned ? null : { id, pinned: true, anchor: event.currentTarget });
      },
      "aria-haspopup": "dialog" as const,
      "aria-expanded": shown?.id === id && shown.pinned || false,
      "aria-describedby": shown?.id === id && !shown.pinned ? popoverId : undefined
    };
  }
  return <div className="editor-participants" role="group" aria-label={`其他文档参与者，${people.length} 人`}>
    {people.slice(0, limit).map(person => <button key={person.id} className="editor-participant-button"
      aria-label={`${displayName(person)}，${roleName[person.role]}，${presenceName(person)}`} {...buttonProps(person.id)}>
      <Avatar person={person} />
    </button>)}
    {people.length > limit && <button className="editor-participant-overflow"
      aria-label={`查看全部 ${people.length} 位其他参与者`} {...buttonProps("all")}>+{people.length - limit}</button>}
    {shown && createPortal(<section id={popoverId} ref={card} className="editor-participants-card"
      role={shown.pinned ? "dialog" : "tooltip"} aria-label={person ? displayName(person) : "文档参与者"}
      style={position} onMouseEnter={() => clearTimeout(closeTimer.current)} onMouseLeave={leave}>
      <header><span>{person ? "文档参与者" : `其他参与者 · ${people.length}`}</span>
        {shown.pinned && <button aria-label="关闭参与者信息" onClick={() => close(true)}><X size={14} /></button>}
      </header>
      <div className="editor-participants-list">
        {(person ? [person] : people).map(person => {
          const editable = shown.pinned && canManage && !person.visitor && person.role !== "owner";
          const direct = person.grants?.some(grant => grant.kind === "document") || !person.inherited;
          const folders = [...new Map(person.grants?.filter(grant => grant.kind === "folder")
            .map(grant => [grant.sourceId, grant]) || []).values()];
          return <div key={person.id} className="editor-participant-detail">
            <div className="editor-participant-profile">
              <Avatar person={person} />
              <div className="editor-participant-info"><strong>{displayName(person)}</strong>
                <small data-online={String(person.online)}>{presenceName(person)}</small>
              </div>
            </div>
            <div className="editor-participant-permission">
              {editable && direct ? <>
                <span className="editor-participant-label">会话权限</span>
                <select aria-label={`${displayName(person)} 的权限`} value={person.role} disabled={busy}
                onChange={event => {
                  const role = event.target.value as "viewer" | "editor" | "removed";
                  if (role === "removed") setConfirm(person); else void update(person, role);
                }}>
                  <option value="viewer">可查看</option><option value="editor">可编辑</option>
                  <option value="removed">移除会话授权</option>
                </select>
              </> : <span className="editor-participant-permission-value">{roleName[person.role]}
                {person.inherited && <span className="editor-participant-label"> · 来自文件夹分享</span>}
              </span>}
            </div>
            {editable && folders.map(grant => <div className="editor-participant-source" key={grant.sourceId}>
              <Folder size={12} aria-hidden="true" />
              <span className="editor-participant-folder-name" title={grant.name}>{grant.name}</span>
              <button className="editor-participant-link" aria-label={`管理文件夹「${grant.name}」权限`}
                disabled={busy} onClick={() => { close(); onManage(grant); }}>管理<ArrowUpRight size={11} aria-hidden="true" /></button>
            </div>)}
          </div>
        })}
      </div>
      {shown.pinned && canManage && <footer className="editor-participants-footer">
        <button disabled={busy} onClick={() => { close(); onManage(); }}>
          <span>分享与权限管理</span><ChevronRight size={14} aria-hidden="true" />
        </button>
      </footer>}
      {confirm && <div className="editor-participant-confirm" role="alert"><p>移除 {displayName(confirm)} 的会话授权？
        {confirm.grants?.some(grant => grant.kind === "folder") ? "文件夹继承权限仍会保留。" : ""}</p>
        <div><button disabled={busy} onClick={() => setConfirm(null)}>取消</button>
          <button className="editor-participant-remove" disabled={busy} onClick={() => void update(confirm, "removed")}>确认移除</button>
        </div>
      </div>}
      {error && <p className="editor-participant-message" role="alert">{error}</p>}
      {notice && <p className="editor-participant-message" role="status">{notice}</p>}
    </section>, document.body)}
  </div>;
}
