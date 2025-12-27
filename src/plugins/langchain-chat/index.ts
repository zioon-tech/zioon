/**
 * Zion LangChain Chat Plugin
 * Main entry point - converts extension to plugin format
 */

import { activate as activateLangchainChat } from './activate';
import type { PluginModule, PluginContext } from '../../../plugin/types';

export const activate: PluginModule['activate'] = async (context: PluginContext) => {
  await activateLangchainChat(context);
};

export const deactivate: PluginModule['deactivate'] = async () => {
  // Cleanup logic if needed
};
