import { randomUUID } from "node:crypto";

/** Idempotent fixture upgrade in the same local preview database. Existing
 * sample data is retained; no team, contacts or device is needed by this demo. */
export async function seedSharingPreview({ config, call, save }) {
  if (config.sharingSeedVersion === 1) return;
  const [owner, partner, guest] = config.accounts;
  const own = (path, method, body) => call(owner.token, owner.personalSpaceId, path, method, body);
  const document = async (key, title, text) => {
    if (!config[key]) {
      const { session } = await own("/v1/sessions", "POST", { title });
      config[key] = session.id;
      await save();
    }
    const exists = await own(`/v1/workbench-state/sessions/${encodeURIComponent(config[key])}`).catch(error => {
      if (error.statusCode === 404) return null;
      throw error;
    });
    if (!exists?.text) await own(`/v1/workbench-state/sessions/${encodeURIComponent(config[key])}`, "PUT",
      { text, meta: { title, titleAuto: false } });
  };
  await document("sharingPrivateDocumentId", "自己的工作资料",
    "user OWNER_PRIVATE_PREVIEW：这是提供者的个人资料，收到模型分享也不能读取。\nassistant 仅本人可见。\nuser ");
  await document("sharingDocumentId", "一起做旅行计划",
    "user 我们在这篇共享会话里整理周末旅行。模型和设备权限分别授予。\nassistant 先确认预算，再安排路线。\nuser ");
  await document("sharingFolderDocumentId", "共同清单",
    "user 整理我们共同的清单。\nassistant 文件夹中的内容按文件夹分享权限开放。\nuser ");
  await document("sharingPrivateChildId", "文件夹里保留的私密笔记",
    "user PRIVATE_CHILD_PREVIEW：这篇笔记保持私密，不继承文件夹的分享。\nuser ");
  config.sharingFolderId ||= `folder:${randomUUID()}`;
  const treeResult = await own("/v1/workbench-state/tree");
  const tree = treeResult.tree || { id: "root", type: "folder", title: "我的会话", children: [] };
  const baseTree = structuredClone(tree);
  tree.children ||= [];
  if (!tree.children.some(node => node.id === config.sharingFolderId)) {
    const ids = new Set([config.sharingFolderDocumentId, config.sharingPrivateChildId]);
    tree.children = tree.children.filter(node => !ids.has(node.id));
    tree.children.push({ id: config.sharingFolderId, type: "folder", title: "一起处理的事情", children: [
      { id: config.sharingFolderDocumentId, type: "session", title: "共同清单" },
      { id: config.sharingPrivateChildId, type: "session", title: "文件夹里保留的私密笔记" }
    ] });
    await own("/v1/workbench-state/tree", "PUT", { tree, base_tree: baseTree });
  }
  await own(`/v1/sharing/documents/${encodeURIComponent(config.sharingPrivateChildId)}/privacy`, "PUT", { private: true });
  const sources = (await own("/v1/sharing/sources")).sources;
  const source = sources.find(model => model.id === "spaces-local-fixture") || sources[0];
  if (!source) throw new Error("Local sharing model source is unavailable.");
  const ensure = async (key, input, recipient) => {
    const sent = (await own("/v1/sharing?direction=sent")).shares;
    let current = sent.find(share => share.id === config[key]);
    if (!current) {
      const result = await own("/v1/sharing", "POST", input);
      config[key] = result.share.id;
      await save();
      await call(recipient.token, recipient.personalSpaceId, "/v1/sharing/accept", "POST", { token: result.invitation.token });
    } else if (!current.recipients?.some(r => r.id === recipient.userId && r.status === "active")) {
      const { invitation } = await own(`/v1/sharing/${encodeURIComponent(current.id)}/invitations`, "POST", {});
      await call(recipient.token, recipient.personalSpaceId, "/v1/sharing/accept", "POST", { token: invitation.token });
    }
  };
  await ensure("sharingModelId", { kind: "model", sourceId: source.id, name: "对象分享的模型", monthlyCalls: 500 }, partner);
  await ensure("sharingDocumentShareId", { kind: "document", sourceId: config.sharingDocumentId, name: "一起做旅行计划", role: "editor" }, partner);
  await ensure("sharingFolderShareId", { kind: "folder", sourceId: config.sharingFolderId, name: "一起处理的事情", role: "editor" }, partner);
  await ensure("sharingViewerShareId", { kind: "document", sourceId: config.sharingDocumentId, name: "只读旅行计划", role: "viewer" }, guest);
  config.sharingSeedVersion = 1;
  await save();
}
