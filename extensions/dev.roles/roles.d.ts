import type { EditorState, Extension } from "@codemirror/state";
import type { OutlineBlock } from "../../src/editor/conversation-outline";
export function roles(opts?: { readOnly?: boolean; prefixes?: string[]; highlightBlockRoles?: string[] }): Extension;
export const BASE_ROLE_PREFIXES: string[];
export function getEffectivePrefixes(opts?: { readOnly?: boolean; prefixes?: string[] }): string[];
export function readConversationRoleBlocks(state: EditorState, prefixes?: string[]): OutlineBlock[];
export function applyRoleNavigationSelection(...args: any[]): boolean;
