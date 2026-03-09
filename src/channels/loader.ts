import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { logger } from '../logger.js';
import { registerChannel, type ChannelSetup } from './registry.js';

/**
 * Dynamically load channel modules from a directory.
 * Each .js file must export a default `setup(registerChannel)` function.
 */
export async function loadChannelsFromDirectory(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    logger.warn({ dir }, 'Channels directory does not exist — no channels will load');
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  if (files.length === 0) {
    logger.warn({ dir }, 'No .js channel files found in directory');
    return;
  }

  for (const file of files) {
    const filePath = path.resolve(dir, file);
    try {
      // Use file:// URL for dynamic import (required for absolute paths in ESM)
      const mod = await import(pathToFileURL(filePath).href);
      const setup: ChannelSetup | undefined = mod.default;
      if (typeof setup !== 'function') {
        logger.warn({ file }, 'Channel file does not export a default setup function — skipping');
        continue;
      }
      setup(registerChannel);
      logger.info({ file }, 'Channel loaded from directory');
    } catch (err) {
      logger.error({ file, err }, 'Failed to load channel file');
    }
  }
}
