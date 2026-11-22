import { createSharingClient } from "../../../packages/runtime-client/src/sharing.mjs";
import { safeText } from "./cli-terminal.mjs";

export const SHARING_USAGE = `Sharing

  zioon share received|sent
  zioon share sources
  zioon share model <model-id> [--limit <monthly-calls>]
  zioon share document <session-id> [--role viewer|editor]
  zioon share folder <folder-id> [--role viewer|editor]
  zioon share preview <invitation-link>
  zioon share accept <invitation-link>
  zioon share invite <share-id>
  zioon share revoke <share-id> [--recipient <id> | --invitation <id>]
  zioon share leave <share-id>
  zioon share documents <folder-share-id>
  zioon share private <session-id> on|off
  zioon chat --shared <share-id> [--document <session-id>]

  Model recipients use their own account and private conversations.
  Content links grant access to the original conversation or folder.
  --role defaults to viewer; editor also permits generation.
  Links default to one acceptance and expire after 7 days.
  --invite-days <1–30> · --claims <1–100> · --duration-days <1–365>
  --title <name> · --json · --account · --url <url>
`;

const values = new Set(["--url", "--runtime-profile", "--space", "--title", "--role", "--limit",
  "--recipient", "--invitation", "--invite-days", "--claims", "--duration-days"]);
const flags = new Set(["--account", "--json", "--jsonl"]);
const required = (value, label) => {
  if (!value) throw new Error(`${label} is required. See zioon share --help`);
  return value;
};
const number = (value, label) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a positive integer`);
  return Number(value);
};
export function parseSharingArgs(args) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (values.has(value)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${value} requires a value`);
      options[value] = args[++i];
    } else if (flags.has(value)) continue;
    else if (value.startsWith("-")) throw new Error(`Unknown sharing option: ${value}`);
    else positional.push(value);
  }
  return { positional, options };
}

export function printSharingResult(output, result, { json = false } = {}) {
  const write = value => output.write(`${safeText(value)}\n`);
  if (json) { write(JSON.stringify(result)); return; }
  if (result.shares || result.sources) {
    const rows = result.shares || result.sources;
    if (!rows.length) write(result.sources ? "No models available to share." : "No shares yet.");
    for (const row of rows) {
      write(`${row.id}  ${row.name || row.label || row.id} · ${row.kind || "model"}${row.owner?.name ? ` · ${row.owner.name}` : ""}${row.role ? ` · ${row.role}` : ""}${row.status ? ` · ${row.status}` : ""}`);
      if (row.usage?.limit) write(`  Monthly calls: ${row.usage.calls}/${row.usage.limit}`);
      for (const recipient of row.recipients || []) write(`  Recipient: ${recipient.name || recipient.id} · ${recipient.id} · ${recipient.status}`);
      for (const invite of row.invitations || []) write(`  Invitation: ${invite.id} · ${invite.claims}/${invite.maxClaims} · ${invite.status}`);
    }
    return;
  }
  if (result.share) {
    const s = result.share;
    write(`${s.name} · ${s.kind} · ${s.role}${s.owner?.name ? ` · provided by ${s.owner.name}` : ""}`);
    write(`Share: ${s.id}`);
    if (s.kind === "model") write("Available in /model. Your conversations remain private.");
    else if (!result.invitation) write(`Open: zioon chat --shared ${s.id}${s.kind === "folder" ? " --document <id>" : ""}`);
  }
  if (result.invitation) {
    write(`Invitation expires: ${new Date(result.invitation.expiresAt).toISOString()}`);
    write(result.invitation.url);
  }
  if (result.tree) {
    const visit = (node, depth = 0) => {
      write(`${"  ".repeat(depth)}${node.id}  ${node.title || "Untitled"}`);
      for (const child of node.children || []) visit(child, depth + 1);
    };
    visit(result.tree);
  }
  if (result.revoked) write("Access revoked.");
  if (result.removed) write("Share removed from your account.");
  if (typeof result.private === "boolean") write(`Conversation privacy: ${result.private ? "private" : "inherits folder sharing"}`);
}

export async function runSharingCli({ args, target, headers, output, fetchImpl, signal }) {
  const { positional: p, options: o } = parseSharingArgs(args);
  const api = createSharingClient({ baseUrl: target.baseUrl, headers, fetchImpl, signal });
  const action = p[0] || "received", id = p[1];
  let result;
  const invitation = {
    ...(o["--invite-days"] ? { inviteDays: number(o["--invite-days"], "--invite-days") } : {}),
    ...(o["--claims"] ? { maxClaims: number(o["--claims"], "--claims") } : {})
  };
  if (["received", "sent"].includes(action)) result = await api.list(action);
  else if (action === "sources") result = await api.sources();
  else if (["model", "document", "folder"].includes(action)) {
    const role = o["--role"] || "viewer";
    if (action !== "model" && !["viewer", "editor"].includes(role)) throw new Error("--role must be viewer or editor");
    result = await api.create({ kind: action, sourceId: required(id, "Source ID"), ...invitation,
      ...(o["--title"] ? { name: o["--title"] } : {}),
      ...(action === "model" ? { monthlyCalls: o["--limit"] ? number(o["--limit"], "--limit") : 1000 } : { role }),
      ...(o["--duration-days"] ? { durationDays: number(o["--duration-days"], "--duration-days") } : {}) });
  } else if (action === "preview") result = await api.preview(required(id, "Invitation"));
  else if (action === "accept") {
    const reviewed = await api.preview(required(id, "Invitation"));
    if (!args.includes("--json") && !args.includes("--jsonl")) {
      output.write(`Accepting ${safeText(reviewed.share.name)} · ${safeText(reviewed.share.role)} · provided by ${safeText(reviewed.share.owner.name)}\n`);
    }
    result = await api.accept(id);
  } else if (action === "invite") result = await api.invite(required(id, "Share ID"), invitation);
  else if (action === "revoke") {
    if (o["--recipient"] && o["--invitation"]) throw new Error("Choose --recipient or --invitation");
    result = await api.revoke(required(id, "Share ID"), {
      ...(o["--recipient"] ? { recipientId: o["--recipient"] } : {}),
      ...(o["--invitation"] ? { invitationId: o["--invitation"] } : {}) });
  } else if (action === "leave") result = await api.leave(required(id, "Share ID"));
  else if (action === "documents") result = await api.documents(required(id, "Folder share ID"));
  else if (action === "private") {
    if (!["on", "off"].includes(p[2])) throw new Error("Use: zioon share private <session-id> on|off");
    result = await api.privacy(required(id, "Session ID"), p[2] === "on");
  } else throw new Error(`Unknown sharing action: ${action}. See zioon share --help`);
  printSharingResult(output, result, { json: args.includes("--json") || args.includes("--jsonl") });
  return result;
}

export async function resolveSharedChatTarget(api, shareId, documentId = "") {
  const share = (await api.list()).shares.find(s => s.id === shareId);
  if (!share || share.status !== "active") throw new Error("This content share is unavailable. Check zioon share received.");
  if (share.kind === "model") throw new Error("Choose a shared model with /model in your own conversation.");
  if (share.kind === "document") {
    if (documentId && documentId !== share.sourceId) throw new Error("The document does not belong to this share.");
    documentId = share.sourceId;
  } else {
    const { tree } = await api.documents(share.id);
    const find = node => node?.type === "session" && node.id === documentId ? node : (node?.children || []).map(find).find(Boolean);
    if (!documentId || !find(tree)) throw new Error("Choose a document ID from: zioon share documents " + share.id);
  }
  return { ...share, documentId };
}
