export type Kind = "skill" | "plugin" | "mcp";
export type Tool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type Model = { id: string; name?: string; supportsTools?: boolean; supportsStreaming?: boolean };
export type Schema = { type?: string; title?: string; description?: string; default?: unknown;
  enum?: Array<string | number>; properties?: Record<string, Schema>; required?: string[] };
export type Installation = {
  version: string; enabled: boolean; status: string; executionEpoch: string;
  updateAvailable?: boolean; config?: { nodeId: string; workspaceRoot: string; credentialsFile?: string; settings?: Record<string, unknown> };
  validation?: { tools?: Tool[] };
  workspace?: { directory: string };
  activeRevision?: { digest: string; activatedAt: number };
  components?: Array<{ id: string; name: string; kind: string; status: string; tools?: Tool[] }>;
};
export type Entry = {
  id: string; name: string; summary: string; description: string; category: string;
  kind: Kind; version: string; status?: string; visibility?: string; license?: string; sourceUrl?: string;
  changelog?: string; digest: string; publishedAt?: number;
  publisher: { id: string; name: string; origin: string };
  versions: Array<{ version: string; digest: string; changelog?: string }>;
  installation?: Installation; installedRelease?: Entry;
  components: Array<{ id: string; name: string; kind: string; description?: string; requirements?: string[]; tools?: Tool[] }>;
  artifact?: { kind: string; plugin?: { settingsSchema?: Schema; connection?: { required?: boolean; label?: string };
    capabilities?: Array<{ id: string; kind: string; models?: Model[] }> } };
};
export type Contribution = {
  id: string; userId?: string; status: string; manifest: Entry; feedback?: string; digest?: string; updatedAt?: number;
};
export type Snapshot = { accountId?: string; revision?: number; categories: string[]; entries: Entry[];
  contributions?: Contribution[]; canReview?: boolean };
export type Account = { authenticated: boolean; sharedAuthenticated?: boolean; generation?: string;
  user?: { id: string; name: string; email: string };
  scopes?: string[]; capabilities?: { loginSettingsUrl?: string } };
export type Connection = { nodeId: string; label: string; kind: string; workspaceRoot: string; status: string };
export type Run = { id: string; status: string; output?: string; error?: string };
