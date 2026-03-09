import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { loadChannelsFromDirectory } from './loader.js';
import { getRegisteredChannelNames } from './registry.js';

describe('loadChannelsFromDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-channels-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads nothing from non-existent directory', async () => {
    await loadChannelsFromDirectory('/tmp/does-not-exist-nanoclaw');
    // Should not throw
  });

  it('loads nothing from empty directory', async () => {
    await loadChannelsFromDirectory(tmpDir);
    // Should not throw
  });

  it('loads a channel module that exports default setup', async () => {
    const channelCode = `
      export default function setup(register) {
        register('test-dynamic', () => null);
      }
    `;
    fs.writeFileSync(path.join(tmpDir, 'test-channel.js'), channelCode);

    await loadChannelsFromDirectory(tmpDir);
    expect(getRegisteredChannelNames()).toContain('test-dynamic');
  });

  it('skips files without default export', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.js'), 'export const x = 1;');
    await loadChannelsFromDirectory(tmpDir);
    // Should not throw, just skip
  });

  it('skips non-.js files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# hi');
    await loadChannelsFromDirectory(tmpDir);
    // Should not throw
  });
});
