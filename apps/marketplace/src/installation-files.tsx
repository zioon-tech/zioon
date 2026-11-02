import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, Select, Space, Tag } from "antd";
import { request, runtimePath } from "./api";
import { extensionRunRequest } from "../../../packages/runtime-client/src/extensions.mjs";
import type { Entry, Run } from "./types";

type Files = { directory: string; hash: string; files?: Record<string, string>; paths?: string[];
  path?: string; content?: string };
export function InstallationFiles({ entry, refresh }: { entry: Entry; refresh: () => Promise<unknown> }) {
  const { message, modal } = App.useApp();
  const [data, setData] = useState<Files>(), [path, setPath] = useState(""), [content, setContent] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [runId, setRunId] = useState("");
  const mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const operate = async (action: string, arguments_: Record<string, unknown> = {}) => {
    if (busy) return;
    setBusy(true); setError("");
    controller.current = new AbortController();
    try {
      const accepted = await request<{ runId: string }>(runtimePath("/v1/runs"), { method: "POST",
        signal: controller.current.signal, body: extensionRunRequest(entry, action, { arguments: arguments_ }) });
      setRunId(accepted.runId);
      let run: Run | undefined;
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline && mounted.current) {
        run = (await request<{ run: Run }>(runtimePath("/v1/runs/" + encodeURIComponent(accepted.runId)),
          { signal: controller.current.signal })).run;
        if (["completed", "failed", "aborted", "interrupted"].includes(run.status)) break;
        await new Promise<void>((done) => {
          const signal = controller.current!.signal;
          const cancelled = () => { clearTimeout(timer); done(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", cancelled); done(); }, 1000);
          signal.addEventListener("abort", cancelled, { once: true });
        });
      }
      if (!mounted.current) return;
      if (run?.status !== "completed") throw new Error(run?.error || run?.output || "尚未确认操作结果，请查看运行记录并刷新文件。");
      const result = JSON.parse(run.output || "{}");
      if (result.files) {
        const selected = arguments_.path as string || path || Object.keys(result.files)[0];
        setData(result); setPath(selected); setContent(result.files[selected] || "");
      }
      await refresh();
      if (action === "workspace-reload") message.success("个人版本已生效，Workbench 将自动加载对应界面");
      if (action === "workspace-restore") message.success("已恢复发布版；个人文件仍然保留");
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "文件操作未完成");
    } finally { if (mounted.current) setBusy(false); }
  };
  const dirty = !!data && content !== data.files?.[path];
  const select = (next: string) => {
    const apply = () => { setPath(next); setContent(data?.files?.[next] || ""); };
    if (dirty) modal.confirm({ title: "放弃当前未保存的修改？", okText: "放弃", cancelText: "继续编辑", onOk: apply });
    else apply();
  };
  return <div>
    <p>文件保存在你的工作区。保存后点击「重新加载」使个人版本生效。</p>
    <Space wrap style={{ marginBottom: 16 }}>
      <Button loading={busy} onClick={() => {
        if (dirty) modal.confirm({ title: "放弃当前未保存的修改并刷新？", onOk: () => operate("workspace-read") });
        else void operate("workspace-read");
      }}>{data ? "刷新文件" : "打开个人文件"}</Button>
      {entry.installation?.activeRevision && <Tag color="blue">已修改 · 仅自己生效</Tag>}
      {entry.installation?.activeRevision && <Button disabled={busy} onClick={() => modal.confirm({
        title: "恢复发布版？", content: "后续任务和界面将使用原发布版。个人文件继续保留，可再次重新加载。",
        okText: "恢复", cancelText: "取消", onOk: () => operate("workspace-restore")
      })}>恢复发布版</Button>}
    </Space>
    {error && <Alert showIcon type="error" message="操作未完成" description={error} style={{ marginBottom: 16 }} />}
    {runId && <p><a href={`https://runtime.zioon.tech/?runId=${encodeURIComponent(runId)}`} target="_blank" rel="noreferrer">查看运行记录</a></p>}
    {data ? <>
      <p><code>{data.directory}</code></p>
      <Space.Compact block style={{ marginBottom: 12 }}>
        <Select aria-label="选择个人文件" value={path} disabled={busy} style={{ width: "100%" }}
          options={Object.keys(data.files || {}).map((value) => ({ value, label: value }))} onChange={select} />
        <Button disabled={busy || dirty} onClick={() => {
          let next = "";
          modal.confirm({ title: "新建文件", content: <Input aria-label="新文件路径" placeholder="references/guide.md"
            onChange={(event) => { next = event.target.value; }} />, okText: "创建", cancelText: "取消",
          onOk: async () => { if (!next.trim()) throw new Error("请填写文件路径");
            await operate("workspace-write", { path: next.trim(), content: "", expectedHash: data.hash }); } });
        }}>新建文件</Button>
      </Space.Compact>
      <Input.TextArea aria-label="个人文件内容" value={content} disabled={busy} spellCheck={false}
        autoSize={{ minRows: 16, maxRows: 30 }} style={{ fontFamily: "monospace" }} onChange={(event) => setContent(event.target.value)} />
      <Space wrap style={{ marginTop: 16 }}>
        <Button disabled={busy || !dirty} onClick={() => operate("workspace-write", { path, content, expectedHash: data.hash })}>保存文件</Button>
        <Button type="primary" loading={busy} disabled={dirty}
          onClick={() => operate("workspace-reload", { expectedHash: data.hash })}>重新加载</Button>
        {dirty && <span>先保存当前修改</span>}
      </Space>
    </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开后可以查看和编辑该安装的完整文件。" />}
  </div>;
}
