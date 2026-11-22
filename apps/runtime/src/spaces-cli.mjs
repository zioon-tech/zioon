import { readFile, writeFile } from "node:fs/promises";
import { createSpacesClient } from "../../../packages/runtime-client/src/spaces.mjs";
import { printList, safeText } from "./cli-terminal.mjs";

export const SPACES_USAGE = `Shared Spaces

  zioon space list
  zioon space show --space <id>
  zioon space create <name>
  zioon space members|groups|resources|usage|knowledge|audit --space <id>
  zioon space invite --space <id> --recipient <contact-code|email> [--role member|viewer|admin]
  zioon space accept <invitation-token-or-link>
  zioon space sources --space <id> --from <personal-space-id>
  zioon space resource add --space <id> --from <id> --kind model|skill|plugin|device --resource <id> --reviewed
      [--root <dedicated-path> --tool <name>] [--limit <calls>]
  zioon space resource pause|resume|revoke <binding-id> --space <id>
  zioon space resource configure <binding-id> --space <id> --access-file <resource-settings.json>
  zioon space group save <id> --space <id> --access-file <group.json>
  zioon space group create --space <id> --access-file <group.json>
  zioon space group remove <id> --space <id>
  zioon space owner offer <contact-code>|accept <transfer-id> --space <id>
  zioon space model <binding-id> --space <id>
  zioon space budget --space <id> --hard-limit <calls> [--budget-scope space|member:<id>]
  zioon contact list|add|remove [contact-code]
  zioon share <document-id> --space <id>
  zioon share <document-id> --space <id> --access-file <reviewed-audience.json>
  zioon share <document-id> --space <id> --destination <id> --markdown <reviewed.md> --reviewed --request-id <stable-id> [--mode copy|move] [--asset <id>]
  zioon share publish <document-id> --space <id> --markdown <reviewed.md> --reviewed
  zioon share knowledge <document-id> --space <id> --markdown <reviewed.md> --reviewed
  zioon share retry --space <destination> --request-file <saved-transfer.json> --reviewed
  Transfer --request-file saves the complete reviewed request before sending.

  Add --account for account login, or --runtime-profile <name>.
  --space pins each process. ZIOON_SPACE_ID is the default; /space switches interactive chat.
  --json prints machine-readable results.
`;

const values = new Set(["--space", "--url", "--runtime-profile", "--from", "--recipient", "--role", "--kind",
  "--resource", "--root", "--tool", "--limit", "--document", "--destination", "--markdown", "--title",
  "--access-file", "--budget-scope", "--hard-limit", "--mode", "--request-id", "--asset", "--request-file"]);
const flags = new Set(["--reviewed", "--account", "--json", "--jsonl"]);
const arg = (args, key, fallback = "") => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const all = (args, key) => args.flatMap((value, index) => value === key ? [args[index + 1]] : []);
function parse(args) {
  const positional = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (values.has(value)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${value} requires a value`);
      index++;
    } else if (flags.has(value)) continue;
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  return positional;
}
const required = (value, label) => { if (!value) throw new Error(`${label} is required. See zioon space --help`); return value; };
function number(value, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}
export async function runSpacesCli({ command, args, target, headers, output, environment, fetchImpl, signal }) {
  const positional = parse(args), api = createSpacesClient({ baseUrl: target.baseUrl, spaceId: target.spaceId, headers, fetchImpl, signal });
  const json = args.includes("--json") || args.includes("--jsonl");
  let result, rows;
  const action = positional[0] || "list";
  if (command === "contact") {
    if (action === "list") { result = await api.contacts(); rows = result.contacts; }
    else if (action === "add") result = await api.addContact(required(positional[1], "Contact code"));
    else if (action === "remove") result = await api.removeContact(required(positional[1], "Contact code"));
    else throw new Error(`Unknown contact action: ${action}`);
  } else if (command === "space") {
    if (action === "list") { result = await api.list(); rows = result.spaces.map(s => ({ ...s, status: `${s.kind} · ${s.membership.role}` })); }
    else if (action === "show") result = await api.describe();
    else if (action === "create") result = await api.create(required(positional.slice(1).join(" ") || arg(args, "--title"), "Space name"));
    else if (action === "accept") {
      let token = required(positional[1], "Invitation");
      try { token = new URL(token).searchParams.get("spaceInvite") || token; } catch {}
      result = await api.accept(token);
    } else if (action === "invite") {
      const recipient = required(arg(args, "--recipient"), "--recipient");
      result = await api.mutate("invitations", "POST", { ...(recipient.includes("@") ? { email: recipient } : { userId: recipient }), role: arg(args, "--role", "member") });
      const url = new URL(target.baseUrl); url.searchParams.set("spaceInvite", result.invitation.token); result.invitation.url = url.toString();
    } else if (action === "sources") {
      result = await api.get("sources", new URLSearchParams({ origin: required(arg(args, "--from"), "--from") }).toString()); rows = result.sources;
    } else if (["members", "groups", "resources", "usage", "knowledge", "audit"].includes(action)) {
      result = await api.get(action === "resources" ? "capabilities" : action);
      rows = result.members || result.groups || result.capabilities || result.sources || result.events;
    } else if (action === "resource") {
      const operation = positional[1];
      if (operation === "add") {
        if (!args.includes("--reviewed")) throw new Error("Review the resource and its data access, then pass --reviewed");
        result = await api.mutate("capabilities", "POST", {
          kind: required(arg(args, "--kind"), "--kind"), originSpaceId: required(arg(args, "--from"), "--from"),
          originResourceId: required(arg(args, "--resource"), "--resource"), transferApproved: true,
          dedicatedRoot: arg(args, "--root") || undefined, allowedTools: all(args, "--tool").length ? all(args, "--tool") : undefined,
          limits: { monthlyCalls: arg(args, "--limit") === "" ? null : number(arg(args, "--limit"), "--limit") }, audienceMode: "space"
        });
      } else if (["pause", "resume", "revoke"].includes(operation)) {
        const id = required(positional[2], "Binding ID"), current = (await api.get("capabilities")).capabilities.find(r => r.id === id);
        if (!current) throw new Error("Binding not found");
        result = await api.mutate(`capabilities/${encodeURIComponent(id)}`, "PATCH", { expectedRevision: current.revision,
          status: { pause: "disabled", resume: "active", revoke: "revoked" }[operation] });
      } else if (operation === "configure") {
        const id = required(positional[2], "Binding ID"), current = (await api.get("capabilities")).capabilities.find(r => r.id === id);
        if (!current) throw new Error("Binding not found");
        const body = JSON.parse(await readFile(required(arg(args, "--access-file"), "--access-file"), "utf8"));
        result = await api.mutate(`capabilities/${encodeURIComponent(id)}`, "PATCH", { ...body, expectedRevision: current.revision });
      } else throw new Error("Use resource add|configure|pause|resume|revoke");
    } else if (action === "group") {
      const id = positional[1] === "create" ? "" : required(positional[2], "Group ID");
      if (positional[1] === "create") {
        const body = JSON.parse(await readFile(required(arg(args, "--access-file"), "--access-file"), "utf8"));
        result = await api.mutate("groups", "POST", body);
      } else if (positional[1] === "remove") result = await api.mutate(`groups/${encodeURIComponent(id)}`, "DELETE");
      else if (positional[1] === "save") {
        const current = (await api.get("groups")).groups.find(g => g.id === id);
        const body = JSON.parse(await readFile(required(arg(args, "--access-file"), "--access-file"), "utf8"));
        result = await api.mutate(`groups/${encodeURIComponent(id)}`, "PUT", { ...body, expectedRevision: current?.revision || 0 });
      } else throw new Error("Use group create|save|remove");
    } else if (action === "owner") {
      const id = required(positional[2], "Recipient or transfer ID");
      if (positional[1] === "offer") result = await api.mutate("ownership", "POST", { toUserId: id });
      else if (positional[1] === "accept") result = await api.mutate(`ownership/${encodeURIComponent(id)}/accept`, "POST", {});
      else throw new Error("Use owner offer|accept");
    } else if (action === "model") {
      const { space } = await api.describe();
      result = await api.update({ expectedRevision: space.revision, defaultBindingId: required(positional[1], "Model binding ID") });
    } else if (action === "budget") {
      const scopeKey = arg(args, "--budget-scope", "space"), budget = (await api.get("usage")).budgets.find(b => b.scopeKey === scopeKey);
      result = await api.mutate("budgets", "PUT", { scopeKey, hardLimit: number(required(arg(args, "--hard-limit"), "--hard-limit"), "--hard-limit"),
        expectedRevision: budget?.revision || 0 });
    } else throw new Error(`Unknown Space action: ${action}`);
  } else {
    if (action === "retry") {
      if (!args.includes("--reviewed")) throw new Error("Review the saved transfer before retrying (--reviewed)");
      const saved = JSON.parse(await readFile(required(arg(args, "--request-file"), "--request-file"), "utf8"));
      if (saved.version !== 1 || saved.origin !== new URL(target.baseUrl).origin || saved.destinationId !== target.spaceId) {
        throw new Error("Saved transfer does not match this Runtime and destination Space");
      }
      result = await api.transfer(saved.destinationId, saved.input);
      output.write(`${safeText(JSON.stringify(result, null, json ? 0 : 2))}\n`);
      return result;
    }
    const operation = ["publish", "knowledge", "revoke"].includes(action) ? action : "";
    const documentId = required(operation ? positional[1] : positional[0], "Document ID");
    const snapshot = await api.document(documentId);
    const audienceFile = arg(args, "--access-file"), destinationId = arg(args, "--destination");
    if (operation === "revoke") {
      result = await api.mutate(`publications/${encodeURIComponent(required(positional[2], "Publication ID"))}`, "DELETE");
    } else if (audienceFile) {
      const body = JSON.parse(await readFile(audienceFile, "utf8"));
      result = await api.mutateDocument(documentId, "access", "PUT", { ...body, expectedRevision: snapshot.document.aclRevision });
    } else if (destinationId || operation) {
      if (!args.includes("--reviewed")) throw new Error("Review the content, then pass --reviewed");
      const markdown = await readFile(required(arg(args, "--markdown"), "--markdown"), "utf8");
      const title = arg(args, "--title", snapshot.content.title);
      if (destinationId) {
        const input = { sourceSpaceId: target.spaceId, sourceDocumentId: documentId,
        sourceRevision: snapshot.content.revision, sourceAclRevision: snapshot.document.aclRevision, title, markdown,
        reviewed: true, mode: arg(args, "--mode", "copy"),
        requestId: required(arg(args, "--request-id"), "--request-id (reuse this ID and the reviewed input when retrying)"),
        approvedAssetIds: all(args, "--asset") };
        const requestFile = arg(args, "--request-file");
        if (requestFile) await writeFile(requestFile, JSON.stringify({
          version: 1, origin: new URL(target.baseUrl).origin, destinationId, input
        }, null, 2), { flag: "wx", mode: 0o600 });
        result = await api.transfer(destinationId, input);
        if (requestFile) result.requestFile = requestFile;
      }
      else result = await api.mutateDocument(documentId, operation === "publish" ? "publications" : "knowledge", "POST", {
        sourceRevision: snapshot.content.revision, title, reviewed: true, ...(operation === "publish" ? { markdown, approvedAssetIds: all(args, "--asset") } : { text: markdown })
      });
    } else {
      const url = new URL("/shared", target.baseUrl); url.searchParams.set("space", target.spaceId); url.searchParams.set("document", documentId);
      result = { document: snapshot.document, access: snapshot.access, grants: snapshot.grants, url: url.toString() };
    }
  }
  if (rows && !json) printList(output, rows, command, environment);
  else output.write(`${safeText(JSON.stringify(result, null, json ? 0 : 2))}\n`);
  if (command === "contact" && action === "list" && !json) output.write(`Your contact code: ${safeText(result.contactCode)}\n`);
  return result;
}
