export type PluginDataLocation = Readonly<{ nodeId: string; root: string; backend?: "agent-fs"; apiUrl?: string; accessMode?: "mcp" | "cli" }>;
export const DEFAULT_PLUGIN_DATA_DIRECTORY: string;
export function validatePluginId(value: unknown): string;
export function normalizeDataLocation(value: unknown): PluginDataLocation;
export function dataLocationPath(location: PluginDataLocation, relativePath: string): string;
export function dataLocationContext(pluginId: string, location: PluginDataLocation): string;
