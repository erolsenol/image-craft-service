import type { AppConfig } from "../config/index.js";
import {
  adaptPlugin,
  registerPlugin,
  type PluginRegistry,
} from "./interface.js";
import { createRemoveBackgroundPlugin } from "./remove-background.js";
import { createUpscalePlugin } from "./upscale.js";
import { createAutoAltTextPlugin } from "./auto-alt-text.js";
import { createNsfwCheckPlugin } from "./nsfw-check.js";

export function createPluginRegistry(config: AppConfig): PluginRegistry {
  const plugins = new Map();
  const limits = {
    timeoutMs: config.AI_PLUGIN_TIMEOUT_MS,
    maxBytes: config.MAX_UPLOAD_BYTES,
  };
  const worker = (workerUrl: string) => ({ ...limits, workerUrl });
  if (config.REMOVE_BACKGROUND_ENABLED)
    registerPlugin(
      plugins,
      adaptPlugin(
        createRemoveBackgroundPlugin(worker(config.REMBG_URL)),
        limits,
      ),
    );
  if (config.UPSCALE_ENABLED)
    registerPlugin(
      plugins,
      adaptPlugin(createUpscalePlugin(worker(config.UPSCALE_URL)), limits),
    );
  if (config.AUTO_ALT_TEXT_ENABLED)
    registerPlugin(
      plugins,
      adaptPlugin(
        createAutoAltTextPlugin(worker(config.AUTO_ALT_TEXT_URL)),
        limits,
      ),
    );
  if (config.NSFW_CHECK_ENABLED)
    registerPlugin(
      plugins,
      adaptPlugin(createNsfwCheckPlugin(worker(config.NSFW_CHECK_URL)), limits),
    );
  return plugins;
}
