import type { AppConfig } from "../config/index.js";
import { adaptPlugin, type PluginRegistry } from "./interface.js";
import { createRemoveBackgroundPlugin } from "./remove-background.js";

export function createPluginRegistry(config: AppConfig): PluginRegistry {
  const plugins = new Map();
  if (config.REMOVE_BACKGROUND_ENABLED) {
    const plugin = createRemoveBackgroundPlugin({
      workerUrl: config.REMBG_URL,
      timeoutMs: config.REQUEST_TIMEOUT_MS,
      maxOutputBytes: config.MAX_UPLOAD_BYTES,
    });
    plugins.set(plugin.name, adaptPlugin(plugin));
  }
  return plugins;
}
