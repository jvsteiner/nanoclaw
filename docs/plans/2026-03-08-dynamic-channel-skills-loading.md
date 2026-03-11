# Dynamic Channel & Skills Loading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert nanoclaw from baked-in channels and skills to runtime loading from the PVC, so all tenants share one universal image and customization is purely files on disk.

**Architecture:** Channels become standalone JS modules in a `catalog/` directory, compiled separately from the main build. At startup the orchestrator dynamically imports whatever channel files exist at a configurable `CHANNELS_DIR` path (PVC in K8s, local dir in dev). Skills already load from disk — we just make the source path configurable via `SKILLS_DIR` instead of hardcoded `container/skills/`. The Helm init container seeds the PVC with default channels/skills on first boot.

**Tech Stack:** TypeScript/Node.js ESM, vitest, Helm, K8s

---

## Overview of Changes

```
BEFORE                                    AFTER
──────                                    ─────
src/channels/telegram.ts                  catalog/channels/telegram.ts
  ↓ compiled with main build                ↓ compiled separately → catalog/dist/telegram.js
  ↓ statically imported                     ↓ dynamically imported from CHANNELS_DIR
  ↓ calls registerChannel() directly        ↓ exports setup(register) function

container/skills/ baked into image        PVC:/skills/ loaded at runtime
  ↓ COPY in Dockerfile                      ↓ seeded by init container or provisioning
  ↓ hardcoded path in container-runner      ↓ SKILLS_DIR env var
```

**PVC layout after conversion:**
```
PVC root (tenant-data)
├── channels/           ← NEW: channel JS files loaded by orchestrator
│   └── telegram.js
├── skills/             ← NEW: skills loaded by container-runner
│   └── agent-browser/
├── store/
│   └── nanoclaw.db
├── groups/
│   └── {groupFolder}/
└── data/
    ├── ipc/{groupFolder}/
    └── sessions/{groupFolder}/
```

---

### Task 1: Refactor channel module interface

Change channels from self-registering imports to modules that export a `setup` function. This decouples them from the registry's import path so they can be loaded from any location.

**Files:**
- Modify: `/Users/jamie/Code/nanoclaw/src/channels/registry.ts`
- Create: `/Users/jamie/Code/nanoclaw/src/channels/loader.ts`
- Modify: `/Users/jamie/Code/nanoclaw/src/channels/registry.test.ts`
- Create: `/Users/jamie/Code/nanoclaw/src/channels/loader.test.ts`

**Step 1: Add the `ChannelSetup` type to the registry**

In `src/channels/registry.ts`, add the type that channel modules must export:

```typescript
// Add after the ChannelFactory type
export type ChannelSetup = (register: typeof registerChannel) => void;
```

**Step 2: Create the dynamic channel loader**

Create `src/channels/loader.ts`:

```typescript
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
```

**Step 3: Write tests for the loader**

Create `src/channels/loader.test.ts`:

```typescript
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
```

**Step 4: Run tests to verify**

Run: `cd /Users/jamie/Code/nanoclaw && npx vitest run src/channels/loader.test.ts`
Expected: All 5 tests pass.

**Step 5: Commit**

```bash
git add src/channels/registry.ts src/channels/loader.ts src/channels/loader.test.ts
git commit -m "feat: add dynamic channel loader for PVC-based channel loading"
```

---

### Task 2: Convert telegram channel to catalog format

Move telegram from a self-registering module to a standalone file that exports `setup(register)`. Create the catalog directory structure.

**Files:**
- Create: `/Users/jamie/Code/nanoclaw/catalog/channels/telegram.ts`
- Create: `/Users/jamie/Code/nanoclaw/catalog/tsconfig.json`
- Modify: `/Users/jamie/Code/nanoclaw/src/channels/index.ts` (remove static telegram import)

**Step 1: Create catalog directory**

```bash
mkdir -p catalog/channels catalog/dist
```

**Step 2: Create catalog version of telegram channel**

Create `catalog/channels/telegram.ts`. This is the existing `src/channels/telegram.ts` refactored to export a `setup` function instead of self-registering. Key differences:

- No import of `registerChannel` from a relative path — it receives `register` as a parameter
- Imports from nanoclaw internals (`config.js`, `logger.js`, `types.js`) are replaced with inline equivalents or environment reads, since this file runs in the orchestrator process but is loaded from disk
- Since the channel file is loaded into the same Node process, it can access `process.env` directly for config

```typescript
/**
 * Telegram channel for NanoClaw.
 * Loaded dynamically from PVC — exports setup(register) instead of self-registering.
 *
 * Dependencies: grammy (must be installed in the base image)
 */
import fs from 'fs';
import path from 'path';
import { Bot, InputFile } from 'grammy';

// When loaded dynamically, we can't import from the compiled src/.
// Read config from env vars that the orchestrator already sets.
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
const TRIGGER_PATTERN = new RegExp(
  `^@${ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
  'i',
);

// Minimal logger — the orchestrator's pino instance isn't available via import,
// but console output goes to the same pod log.
const log = {
  info: (obj: any, msg?: string) => console.log(JSON.stringify({ level: 'info', ...obj, msg })),
  warn: (obj: any, msg?: string) => console.warn(JSON.stringify({ level: 'warn', ...obj, msg })),
  error: (obj: any, msg?: string) => console.error(JSON.stringify({ level: 'error', ...obj, msg })),
  debug: (obj: any, msg?: string) => console.debug(JSON.stringify({ level: 'debug', ...obj, msg })),
};

export default function setup(register: any) {
  register('telegram', (opts: any) => {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) return null;
    return new TelegramChannel(token, opts);
  });
}

class TelegramChannel {
  name = 'telegram';
  private bot: Bot | null = null;
  private opts: any;
  private botToken: string;

  constructor(botToken: string, opts: any) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id.toString() || 'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onChatMetadata(chatJid, timestamp, chatName);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        log.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      log.info({ chatJid, chatName, sender: senderName }, 'Telegram message stored');
    });

    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.catch((err) => {
      log.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          log.info({ username: botInfo.username, id: botInfo.id }, 'Telegram bot connected');
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) { log.warn('Telegram bot not initialized'); return; }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      log.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      log.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean { return this.bot !== null; }
  ownsJid(jid: string): boolean { return jid.startsWith('tg:'); }

  async disconnect(): Promise<void> {
    if (this.bot) { this.bot.stop(); this.bot = null; log.info('Telegram bot stopped'); }
  }

  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.bot) { log.warn('Telegram bot not initialized'); return; }
    try {
      const numericId = jid.replace(/^tg:/, '');
      const ext = path.extname(filePath).toLowerCase();
      const file = new InputFile(fs.createReadStream(filePath), path.basename(filePath));
      const opts = caption ? { caption } : {};
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        await this.bot.api.sendPhoto(numericId, file, opts);
      } else if (['.mp4', '.mov'].includes(ext)) {
        await this.bot.api.sendVideo(numericId, file, opts);
      } else if (['.mp3', '.ogg', '.wav'].includes(ext)) {
        await this.bot.api.sendAudio(numericId, file, opts);
      } else {
        await this.bot.api.sendDocument(numericId, file, opts);
      }
      log.info({ jid, filePath }, 'Telegram file sent');
    } catch (err) {
      log.error({ jid, filePath, err }, 'Failed to send Telegram file');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      log.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
```

**Step 3: Create catalog tsconfig**

Create `catalog/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./channels",
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["channels/**/*"]
}
```

Note: `strict: false` because catalog channels use `any` types to avoid importing from the main codebase.

**Step 4: Remove static telegram import from barrel**

Edit `src/channels/index.ts` to remove the static import — channels now load dynamically:

```typescript
// Channel self-registration barrel file.
// In production, channels are loaded dynamically from CHANNELS_DIR.
// This file is kept for backward compatibility in dev mode.
// To use static imports in dev, uncomment:
// import './telegram.js';
```

**Step 5: Add catalog build script to package.json**

Add to `scripts` in `package.json`:

```json
"build:channels": "tsc -p catalog/tsconfig.json"
```

**Step 6: Build and verify catalog compiles**

Run: `cd /Users/jamie/Code/nanoclaw && npm run build:channels`
Expected: `catalog/dist/telegram.js` is created.

**Step 7: Commit**

```bash
git add catalog/ src/channels/index.ts package.json
git commit -m "feat: create channel catalog with telegram as first catalog channel"
```

---

### Task 3: Wire dynamic loading into the orchestrator

Update `src/index.ts` to use the dynamic loader instead of static imports. Add `CHANNELS_DIR` config.

**Files:**
- Modify: `/Users/jamie/Code/nanoclaw/src/config.ts`
- Modify: `/Users/jamie/Code/nanoclaw/src/index.ts`

**Step 1: Add CHANNELS_DIR and SKILLS_DIR to config**

In `src/config.ts`, add after the existing path configs:

```typescript
// Dynamic loading directories
// In K8s mode these point into the PVC; in dev mode they default to local dirs.
export const CHANNELS_DIR =
  process.env.CHANNELS_DIR || path.resolve(PROJECT_ROOT, 'catalog', 'dist');
export const SKILLS_DIR =
  process.env.SKILLS_DIR || path.resolve(PROJECT_ROOT, 'container', 'skills');
```

**Step 2: Update index.ts to use dynamic loader**

In `src/index.ts`, replace the static barrel import and channel initialization:

Find the import of `'./channels/index.js'` (around line 10) and replace with:

```typescript
import { loadChannelsFromDirectory } from './channels/loader.js';
```

Find the channel initialization block (around lines 531-546) and add the dynamic load call before it:

```typescript
  // Load channels dynamically from CHANNELS_DIR
  await loadChannelsFromDirectory(CHANNELS_DIR);

  // Create and connect all registered channels.
  for (const channelName of getRegisteredChannelNames()) {
    // ... existing factory/connect code stays the same ...
  }
```

Add `CHANNELS_DIR` to the imports from `'./config.js'`.

**Step 3: Test locally with catalog/dist/**

Run: `cd /Users/jamie/Code/nanoclaw && npm run build:channels && npm run build`
Then verify the orchestrator starts (it will fail to connect without a bot token, but should log "Channel loaded from directory" for telegram).

**Step 4: Commit**

```bash
git add src/config.ts src/index.ts
git commit -m "feat: orchestrator loads channels dynamically from CHANNELS_DIR"
```

---

### Task 4: Make skills source path configurable

Update `container-runner.ts` to read skills from `SKILLS_DIR` instead of the hardcoded `container/skills/` path.

**Files:**
- Modify: `/Users/jamie/Code/nanoclaw/src/container-runner.ts`

**Step 1: Update skills sync to use SKILLS_DIR**

In `src/container-runner.ts`, find the skills sync block (around lines 146-156):

```typescript
  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
```

Replace with:

```typescript
  // Sync skills from SKILLS_DIR into each group's .claude/skills/
  const skillsSrc = SKILLS_DIR;
```

Add the `SKILLS_DIR` import from `'./config.js'` at the top of the file.

**Step 2: Verify build**

Run: `cd /Users/jamie/Code/nanoclaw && npm run build`
Expected: Compiles without errors.

**Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: read skills from configurable SKILLS_DIR instead of hardcoded path"
```

---

### Task 5: Update Dockerfile to remove baked-in skills

The image no longer needs `container/skills/` baked in. Skills and channels come from PVC.

**Files:**
- Modify: `/Users/jamie/Code/nanoclaw/Dockerfile`

**Step 1: Remove the skills COPY line**

In `Dockerfile`, remove this line:

```dockerfile
COPY container/skills/ ./container/skills/
```

The `container/agent-runner/src/` COPY stays — it's the agent runner code, not tenant-specific.

**Step 2: Verify Docker build**

Run: `cd /Users/jamie/Code/nanoclaw && docker build -t nanoclaw-test .`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: remove baked-in skills from Dockerfile (now loaded from PVC)"
```

---

### Task 6: Update Helm chart for channels/skills on PVC

The init container needs to seed channels and skills directories. The ConfigMap needs CHANNELS_DIR and SKILLS_DIR pointing into the PVC.

**Files:**
- Modify: `/Users/jamie/Code/multiclaw/helm/multiclaw-tenant/templates/configmap.yaml`
- Modify: `/Users/jamie/Code/multiclaw/helm/multiclaw-tenant/templates/statefulset.yaml`
- Modify: `/Users/jamie/Code/multiclaw/helm/multiclaw-tenant/values.yaml`

**Step 1: Add path config to ConfigMap**

In `configmap.yaml`, add after the DATA_DIR line:

```yaml
  # Dynamic loading directories on PVC
  CHANNELS_DIR: "/app/tenant-data/channels"
  SKILLS_DIR: "/app/tenant-data/skills"
```

**Step 2: Update init container to create channels/skills dirs**

In `statefulset.yaml`, update the init-dirs command:

```yaml
      initContainers:
        - name: init-dirs
          image: busybox:1.37
          command: ['sh', '-c', 'mkdir -p /data/store /data/groups /data/data/ipc /data/data/sessions /data/channels /data/skills']
```

**Step 3: Add seed init container (optional, for first-time provisioning)**

Add a second init container after init-dirs that copies default channel files if the directory is empty. This uses the orchestrator image itself since it has the compiled channels:

```yaml
        - name: seed-channels
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ['sh', '-c', '
            if [ -z "$(ls -A /data/channels/ 2>/dev/null)" ]; then
              echo "Seeding default channels...";
              cp /app/catalog/dist/*.js /data/channels/ 2>/dev/null || true;
            fi;
            if [ -z "$(ls -A /data/skills/ 2>/dev/null)" ]; then
              echo "Seeding default skills...";
              cp -r /app/container/skills/* /data/skills/ 2>/dev/null || true;
            fi;
          ']
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: tenant-data
              mountPath: /data
```

Wait — this assumes the orchestrator image still has catalog/dist/ and container/skills/ in it. We removed skills in Task 5. So we need a different seeding strategy.

**Revised approach**: Include `catalog/dist/` in the image (it's the platform's channel catalog — not tenant-specific). Remove only `container/skills/` (tenant-specific). The seed container copies from the image's catalog to the PVC on first boot.

This means Task 5's Dockerfile change should also ADD the catalog:

**Step 3 (revised): Update Dockerfile to include catalog/dist/**

In the Dockerfile, replace the removed skills COPY with:

```dockerfile
# Copy compiled channel catalog (platform-provided, not tenant-specific)
COPY catalog/dist/ ./catalog/dist/
```

And update the Docker build to compile channels first:

```dockerfile
# --- Build stage ---
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY catalog/tsconfig.json ./catalog/
COPY catalog/channels/ ./catalog/channels/
COPY src/ ./src/
RUN npx tsc && npx tsc -p catalog/tsconfig.json
```

**Step 4: Add channels/skills Helm values**

In `values.yaml`, add:

```yaml
# Channels to activate (from catalog)
channels:
  - telegram

# Custom skills to deploy (future: populated by provisioning)
skills: []
```

**Step 5: Commit multiclaw changes**

```bash
cd /Users/jamie/Code/multiclaw
git add helm/multiclaw-tenant/
git commit -m "feat: add channels/skills PVC dirs and seed init container"
```

**Step 6: Commit nanoclaw Dockerfile update**

```bash
cd /Users/jamie/Code/nanoclaw
git add Dockerfile
git commit --amend -m "feat: remove baked-in skills, add channel catalog to Dockerfile"
```

---

### Task 7: Update K8s runtime PVC mounts for agent jobs

Agent jobs need skills mounted from the PVC's `skills/` directory instead of from the baked-in image path.

**Files:**
- Modify: `/Users/jamie/Code/nanoclaw/src/container-runner.ts` (the volume mount logic)
- Modify: `/Users/jamie/Code/nanoclaw/src/k8s-runtime.ts` (if skills mount is explicit)

**Step 1: Verify current skills mount path**

The skills sync happens in `container-runner.ts` at the orchestrator level — it copies skills into the group's session dir (`data/sessions/{group}/.claude/skills/`), which is already mounted into agent jobs via the `.claude` subPath mount. So agent jobs already pick up whatever skills are in the session dir.

The only change needed is that the orchestrator now reads from `SKILLS_DIR` (PVC path) instead of `container/skills/` — which we did in Task 4.

No K8s runtime changes needed for skills. The existing mount chain works:

```
PVC:/skills/ → orchestrator reads via SKILLS_DIR
            → copies to PVC:/data/sessions/{group}/.claude/skills/
            → agent job mounts PVC:/data/sessions/{group}/.claude → /home/node/.claude
            → agent sees skills at /home/node/.claude/skills/
```

**Step 2: Verify by reading k8s-runtime.ts mounts**

Confirm the existing `.claude` subPath mount at line 93-95 of k8s-runtime.ts covers skills. No modification needed.

**Step 3: Commit (no-op — document the decision)**

No code changes needed. The existing PVC mount chain already propagates skills from the orchestrator's sync to agent jobs.

---

### Task 8: Add backward-compatible dev mode

In development (Docker mode, no PVC), the system should still work with local files. Ensure CHANNELS_DIR defaults to `catalog/dist/` and SKILLS_DIR defaults to `container/skills/`.

**Files:**
- Verify: `/Users/jamie/Code/nanoclaw/src/config.ts` (already done in Task 3)

**Step 1: Verify defaults work**

The config from Task 3 already provides defaults:
```typescript
export const CHANNELS_DIR =
  process.env.CHANNELS_DIR || path.resolve(PROJECT_ROOT, 'catalog', 'dist');
export const SKILLS_DIR =
  process.env.SKILLS_DIR || path.resolve(PROJECT_ROOT, 'container', 'skills');
```

In dev mode (no env vars set):
- `CHANNELS_DIR` → `./catalog/dist/` (compiled channel JS files)
- `SKILLS_DIR` → `./container/skills/` (local skills directory)

In K8s mode (env vars from ConfigMap):
- `CHANNELS_DIR` → `/app/tenant-data/channels`
- `SKILLS_DIR` → `/app/tenant-data/skills`

**Step 2: Test dev mode end-to-end**

```bash
cd /Users/jamie/Code/nanoclaw
npm run build:channels  # compile catalog
npm run build           # compile main
npm run dev             # should load telegram from catalog/dist/
```

Expected: Log shows "Channel loaded from directory" for telegram.js.

**Step 3: Commit**

No new code — this is verification only.

---

### Task 9: Clean up old static channel code

Remove the old `src/channels/telegram.ts` since it's been replaced by the catalog version. Keep the registry and loader in `src/channels/`.

**Files:**
- Delete: `/Users/jamie/Code/nanoclaw/src/channels/telegram.ts`
- Modify: `/Users/jamie/Code/nanoclaw/src/channels/index.ts` (already done in Task 2)

**Step 1: Delete old telegram channel**

```bash
rm src/channels/telegram.ts
```

**Step 2: Update channels index.ts**

Ensure `src/channels/index.ts` is clean:

```typescript
// Channels are loaded dynamically from CHANNELS_DIR at runtime.
// See src/channels/loader.ts for the loading mechanism.
// Channel files live in catalog/channels/ and are compiled to catalog/dist/.
```

**Step 3: Verify build still works**

Run: `cd /Users/jamie/Code/nanoclaw && npm run build`
Expected: Compiles without errors (telegram.ts is gone, no static import references it).

**Step 4: Run all tests**

Run: `cd /Users/jamie/Code/nanoclaw && npx vitest run`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove static telegram channel, channels now loaded from catalog"
```

---

### Task 10: Build, push, and deploy

Build the updated image, push to GHCR, and deploy to verify everything works end-to-end.

**Files:** None (ops only)

**Step 1: Build channels and main**

```bash
cd /Users/jamie/Code/nanoclaw
npm run build:channels
npm run build
```

**Step 2: Build and push Docker image**

```bash
docker build -t ghcr.io/jvsteiner/nanoclaw:latest .
docker push ghcr.io/jvsteiner/nanoclaw:latest
```

**Step 3: Upgrade Helm release**

```bash
cd /Users/jamie/Code/multiclaw
helm upgrade tenant-test helm/multiclaw-tenant/ \
  --namespace tenant-test \
  --reuse-values
```

The init container will seed `channels/telegram.js` and `skills/` on the PVC on first boot (if the dirs are empty).

**Step 4: Verify logs**

```bash
kubectl logs -n tenant-test statefulset/orchestrator -c orchestrator | head -50
```

Expected: "Channel loaded from directory" log entry, then "Telegram bot connected".

**Step 5: Send a test message via Telegram**

Verify the bot responds as before.

**Step 6: Commit (tag release)**

```bash
cd /Users/jamie/Code/nanoclaw
git tag v1.3.0-dynamic-channels
```

---

## Summary of env vars

| Variable | Default (dev) | K8s (ConfigMap) | Purpose |
|----------|--------------|-----------------|---------|
| `CHANNELS_DIR` | `./catalog/dist` | `/app/tenant-data/channels` | Directory to scan for channel `.js` files |
| `SKILLS_DIR` | `./container/skills` | `/app/tenant-data/skills` | Directory to sync skills from |

## Future: Adding a new channel

To add e.g. Slack support:

1. Create `catalog/channels/slack.ts` with `export default function setup(register) { ... }`
2. Add `@slack/bolt` to package.json dependencies
3. Run `npm run build:channels`
4. Rebuild + push image (deps changed)
5. Copy `catalog/dist/slack.js` to tenant's PVC `channels/` directory
6. Add Slack credentials as K8s Secret
7. Restart orchestrator pod — it picks up the new channel automatically

## Future: Tenant provisioning

A provisioning script/API would:
1. Create namespace + Helm release
2. Copy selected channel `.js` files to PVC `channels/`
3. Copy tenant-specific skills to PVC `skills/`
4. Create K8s Secrets for channel credentials
5. Register initial group in SQLite (or enable auto-registration)
