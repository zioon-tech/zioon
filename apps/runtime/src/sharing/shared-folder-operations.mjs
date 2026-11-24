import { createHash } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";

const text = (value, max = 256) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw accountError(400, "invalid_folder_operation");
  }
  return value.trim();
};
const find = (node, id, parent = null) => {
  if (node?.id === id) return { node, parent };
  for (const child of node?.children || []) {
    const result = find(child, id, node);
    if (result) return result;
  }
  return null;
};
const layout = node => {
  const entries = [];
  const walk = (entry, parent) => {
    entries.push([entry.id, entry.type, parent]);
    for (const child of entry.children || []) walk(child, entry.id);
  };
  walk(node, null);
  return JSON.stringify(entries.sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
};

/** Mutations are restricted to the grant's subtree, in the original owner's store. */
export class SharedFolderOperations {
  constructor({ sharing, store, spaces = null }) { Object.assign(this, { sharing, store, spaces }); }
  async mutate(userId, shareId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw accountError(400, "invalid_folder_operation");
    const action = input.action;
    if (!["createFolder", "createDocument", "rename", "delete", "move"].includes(action)) {
      throw accountError(400, "invalid_folder_operation");
    }
    const token = text(input.operationId, 128);
    const operationId = `shared:${createHash("sha256").update(JSON.stringify([userId, shareId, token])).digest("hex")}`;
    const afterCommit = [];
    const result = await this.sharing.transaction(async client => {
      const grant = await this.sharing.requireGrant(userId, shareId, client, true);
      if (grant.kind !== "folder" || grant.role !== "editor" || grant.originSpaceId !== this.store.spaceId) {
        throw accountError(403, "folder_editor_required", "此操作需要文件夹编辑权限");
      }
      // Use the same row lock as owner mutations before reading or checking the tree.
      await client.query("SELECT revision FROM runtime_workbench_state WHERE space_id=$1 FOR UPDATE", [this.store.spaceId]);
      const duplicate = await this.store.duplicateOperation(operationId, client);
      if (duplicate) return duplicate;
      const tree = await this.sharing.tree(this.store.spaceId, client);
      const root = find(tree, grant.sourceId)?.node;
      if (root?.type !== "folder") throw accountError(404, "shared_folder_not_found");
      const options = { client, afterCommit };
      const targetId = text(input.id || input.parentId || grant.sourceId);
      const target = find(root, targetId);
      if (!target) throw accountError(404, "shared_item_not_found");
      const accessible = async node => {
        if (node.type === "session") {
          await this.sharing.documentAccess(userId, this.store.spaceId, node.id, "edit", client);
        }
        for (const child of node.children || []) await accessible(child);
      };
      let output;
      if (action === "createFolder" || action === "createDocument") {
        if (target.node.type !== "folder") throw accountError(400, "folder_parent_required");
        const title = text(input.title);
        const id = `${action === "createFolder" ? "fld" : "doc"}_${operationId.slice(7, 39)}`;
        const node = { id, type: action === "createFolder" ? "folder" : "session", title };
        if (node.type === "folder") node.children = [];
        else {
          // The provider remains the document owner/manager; the creator
          // receives only the existing folder grant.
          await this.spaces?.registerDocument(grant.providerId, this.store.spaceId, id, client);
          await this.store.updateSession(id, { text: typeof input.text === "string" ? input.text : "", meta: { title, titleAuto: false },
            operation_id: `${operationId}:document` }, options);
        }
        // updateSession may add a root entry; place it explicitly in the shared folder.
        const next = await this.sharing.tree(this.store.spaceId, client);
        const existing = find(next, id);
        if (existing?.parent) existing.parent.children = existing.parent.children.filter(child => child.id !== id);
        const parent = find(next, targetId).node;
        parent.children ||= [];
        parent.children.push(node);
        await this.store.writeTree(next, [], null, "", null, `${operationId}:tree`, options);
        output = { ok: true, id, type: node.type, title };
      } else if (action === "rename") {
        if (target.node.type === "session") await accessible(target.node);
        const title = text(input.title);
        const current = target.node.type === "session"
          ? (await this.store.readSession(targetId, client))?.meta?.title || target.node.title
          : target.node.title;
        if (input.expectedTitle !== undefined && current !== input.expectedTitle) {
          throw accountError(409, "shared_item_changed", "名称已变更，请刷新后重试");
        }
        if (target.node.type === "session") {
          await this.store.updateSession(targetId, { meta: { title, titleAuto: false },
            operation_id: `${operationId}:document` }, options);
        } else {
          target.node.title = title;
          await this.store.writeTree(tree, [], null, "", null, `${operationId}:tree`, options);
        }
        output = { ok: true, id: targetId, type: target.node.type, title };
      } else {
        // Hidden/private descendants cannot be deleted or moved by an editor.
        await accessible(target.node);
        if (action === "delete") {
          if (target.node.type === "folder") {
            if (!input.expectedTree || layout(input.expectedTree) !== layout(target.node)) {
              throw accountError(409, "shared_folder_changed", "文件夹内容已变更，请刷新后重试");
            }
            const deleted = await this.store.deleteFolder(targetId, {
              base_tree: tree, operation_id: `${operationId}:delete`
            }, options);
            output = { ok: true, id: targetId, deletedIds: [targetId, ...deleted.deleted_session_ids] };
          } else {
            await this.store.deleteSession(targetId, { operation_id: `${operationId}:delete` }, options);
            output = { ok: true, id: targetId, deletedIds: [targetId] };
          }
          if (this.spaces) for (const documentId of output.deletedIds.filter(id => id !== targetId || target.node.type === "session")) {
            await client.query(`UPDATE space_documents SET lifecycle='deleted',acl_revision=acl_revision+1,updated_at=$3
              WHERE space_id=$1 AND id=$2`, [this.store.spaceId, documentId, this.sharing.now()]);
            await this.spaces.invalidateKnowledge(client, this.store.spaceId, documentId);
            await client.query(`UPDATE space_publications SET status='revoked',revoked_at=$3
              WHERE space_id=$1 AND document_id=$2 AND status='active'`, [this.store.spaceId, documentId, this.sharing.now()]);
            await this.spaces.emit(client, this.store.spaceId, userId, "document.deleted", "document", documentId);
          }
        } else {
          const destination = find(root, text(input.parentId))?.node;
          if (destination?.type !== "folder" || targetId === root.id || find(target.node, destination.id)) {
            throw accountError(400, "invalid_shared_move");
          }
          if (input.expectedParentId !== undefined && input.expectedParentId !== target.parent?.id) {
            throw accountError(409, "shared_item_changed", "位置已变更，请刷新后重试");
          }
          target.parent.children = target.parent.children.filter(child => child.id !== targetId);
          destination.children ||= [];
          destination.children.push(target.node);
          await this.store.writeTree(tree, [], null, "", null, `${operationId}:tree`, options);
          output = { ok: true, id: targetId };
        }
      }
      await this.store.recordOperation(operationId, `share:${shareId}`, 0, output, this.sharing.now(), client);
      await this.sharing.event(client, shareId, userId, `folder.${action}`, { id: output.id });
      return output; // Never disclose the owner's complete tree or metadata.
    });
    for (const publish of afterCommit) publish();
    return result;
  }
}
