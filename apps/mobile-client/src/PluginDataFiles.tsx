import {
  ArrowLeft,
  BookOpen,
  Clock,
  Database,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Save,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getPluginDataLocation, listFiles, readFile, writePluginDataFile } from "./api";
import { Badge, EmptyState, ErrorState, formatRelativeTime, IconButton, LoadingState, SectionLabel } from "./components";
import type { FileEntry } from "./types";

const QUICK_FILES = [
  { path: "identity.md", title: "Agent", subtitle: "identity.md", icon: ShieldCheck, tone: "blue" },
  { path: "user.md", title: "User", subtitle: "user.md", icon: UserRound, tone: "green" },
  { path: "biography/digest.md", title: "Digest", subtitle: "biography/digest.md", icon: BookOpen, tone: "amber" },
  { path: "biography/events.jsonl", title: "Events", subtitle: "biography/events.jsonl", icon: Database, tone: "red" },
  { path: "projects/index.md", title: "Projects", subtitle: "projects/index.md", icon: FolderOpen, tone: "blue" },
  { path: "projects/attention.md", title: "Attention", subtitle: "projects/attention.md", icon: Clock, tone: "amber" },
] as const;

function compactPath(path: string, root: string): string {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return relative || "/";
}

function parentDirectory(path: string, root: string): string {
  if (!path || path === root) return root;
  const parent = path.replace(/\/+$/, "").slice(0, path.replace(/\/+$/, "").lastIndexOf("/"));
  return parent && parent.startsWith(root) ? parent : root;
}

function fileSizeLabel(size?: number): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function entryKind(entry: FileEntry): "file" | "directory" {
  return (entry.type || entry.kind) === "directory" ? "directory" : "file";
}

export function PluginDataFiles({ pluginId }: { pluginId: string }) {
  const location = useQuery({
    queryKey: ["plugin-data-location", pluginId],
    queryFn: () => getPluginDataLocation(pluginId),
  });
  return <>
    <SectionLabel>Identity 数据</SectionLabel>
    {location.isLoading ? <LoadingState /> : null}
    {location.isError ? <ErrorState error={location.error} onRetry={() => void location.refetch()} /> : null}
    {location.data ? <DataDirectory key={`${pluginId}:${location.data.nodeId}:${location.data.root}`} location={location.data} /> : null}
  </>;
}

function DataDirectory({ location }: { location: { nodeId: string; root: string } }) {
  const client = useQueryClient();
  const [directory, setDirectory] = useState(location.root);
  const [file, setFile] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const filesKey = ["plugin-data-files", location.nodeId, directory];
  const fileKey = ["plugin-data-file", location.nodeId, file];
  const files = useQuery({ queryKey: filesKey, queryFn: () => listFiles("", directory, location.nodeId) });
  const content = useQuery({
    queryKey: fileKey, queryFn: () => readFile("", file, location.nodeId),
    enabled: !!file, refetchOnWindowFocus: draft === null,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!content.data?.content_hash) throw new Error("File version unavailable; refresh before editing");
      await writePluginDataFile(location, file, draft ?? "", content.data.content_hash);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: fileKey });
      setDraft(null);
    },
  });
  const dirty = draft !== null && draft !== content.data?.content;
  const entries = (files.data || []).filter((entry) => {
    const path = String(entry.path || `${directory}/${entry.name}`);
    return path.startsWith(`${location.root}/`) && !path.split("/").includes("..")
      && !path.endsWith(".zion-lock");
  }).sort((left, right) => {
    const leftFolder = entryKind(left) === "directory";
    const rightFolder = entryKind(right) === "directory";
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
    return String(left.name || left.path).localeCompare(String(right.name || right.path));
  });
  const closeFile = () => { setFile(""); setDraft(null); save.reset(); };
  const activePath = file || directory;
  const relativePath = compactPath(activePath, location.root);
  const isJsonl = file.endsWith(".jsonl");
  const readOnly = isJsonl || !!content.data?.truncated || !content.data?.content_hash || save.isPending;
  return <section className="plugin-data-browser">
    <div className="plugin-data-location">
      <span className="plugin-data-node"><Database size={14} />{location.nodeId || "local"}</span>
      <code>{location.root}</code>
    </div>
    <div className="plugin-data-toolbar" aria-label="Identity 数据导航">
      <IconButton
        icon={ArrowLeft}
        label={file ? "关闭文件" : "返回上级"}
        disabled={dirty || save.isPending || (!file && directory === location.root)}
        onClick={() => file ? closeFile() : setDirectory(parentDirectory(directory, location.root))}
      />
      <span className="plugin-data-current">{relativePath}</span>
      <IconButton
        icon={RefreshCw}
        label={file ? "刷新文件" : "刷新目录"}
        disabled={dirty || save.isPending}
        onClick={() => void (file ? content.refetch() : files.refetch())}
      />
    </div>
    {!file && files.isLoading ? <LoadingState /> : null}
    {!file && files.isError ? <ErrorState error={files.error} onRetry={() => void files.refetch()} /> : null}
    {!file && directory === location.root ? (
      <div className="plugin-data-shortcuts">
        {QUICK_FILES.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className="plugin-data-shortcut"
              type="button"
              key={item.path}
              onClick={() => setFile(`${location.root}/${item.path}`)}
            >
              <span className={`row-icon ${item.tone}`}><Icon size={18} /></span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
          );
        })}
      </div>
    ) : null}
    {!file ? (
      <>
        <SectionLabel>{directory === location.root ? "全部文件" : "当前目录"}</SectionLabel>
        <div className="plugin-data-list">
          {entries.map((entry) => {
            const path = String(entry.path || `${directory}/${entry.name}`);
            const folder = entryKind(entry) === "directory";
            const Icon = folder ? Folder : /\.jsonl?$/i.test(path) ? FileJson : FileText;
            return (
              <button
                className="plugin-data-row"
                type="button"
                key={path}
                onClick={() => folder ? setDirectory(path.replace(/\/$/, "")) : setFile(path)}
              >
                <span className="row-icon"><Icon size={18} /></span>
                <span className="row-main">
                  <span className="row-title">{entry.name || path.split("/").at(-1)}</span>
                  <span className="row-preview">
                    {folder ? "目录" : fileSizeLabel(entry.size) || "文件"}
                    {entry.modifiedAt ? ` · ${formatRelativeTime(new Date(entry.modifiedAt).getTime())}` : ""}
                  </span>
                </span>
              </button>
            );
          })}
          {!files.isLoading && !files.isError && !entries.length ? (
            <EmptyState icon={Folder} title="目录为空" />
          ) : null}
        </div>
      </>
    ) : null}
    {file && content.isLoading ? <LoadingState /> : null}
    {file && content.isError ? <ErrorState error={content.error} onRetry={() => void content.refetch()} /> : null}
    {file && content.data ? <div className="plugin-file-editor">
      <div className="plugin-file-meta">
        <Badge tone={readOnly ? "amber" : "green"}>{readOnly ? "只读" : "可编辑"}</Badge>
        {isJsonl ? <Badge>JSONL</Badge> : null}
        {content.data.truncated ? <Badge tone="red">已截断</Badge> : null}
        {content.data.size != null ? <span>{fileSizeLabel(content.data.size)}</span> : null}
      </div>
      <textarea
        aria-label="文件内容"
        spellCheck={false}
        rows={18}
        readOnly={readOnly}
        value={draft ?? content.data.content}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="plugin-file-actions">
        <IconButton icon={X} label="放弃修改" disabled={!dirty || save.isPending} onClick={() => { setDraft(null); save.reset(); }} />
        <span role="status">{save.isPending ? "保存中" : save.isSuccess && !dirty ? "已保存" : dirty ? "未保存" : "无修改"}</span>
        <IconButton icon={Save} label="保存文件" disabled={!dirty || readOnly || save.isPending} onClick={() => save.mutate()} />
      </div>
      {save.isError ? <ErrorState error={save.error} /> : null}
    </div> : null}
  </section>;
}
