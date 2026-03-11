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
// Handles both (obj, msg) and (msg) call styles, and serializes Error objects properly.
function serializeValue(v: any): any {
  if (v instanceof Error) return { message: v.message, name: v.name, stack: v.stack };
  return v;
}
function logEntry(level: string, first: any, second?: string): Record<string, any> {
  if (typeof first === 'string') return { level, msg: first };
  const obj: Record<string, any> = { level };
  for (const [k, v] of Object.entries(first)) obj[k] = serializeValue(v);
  if (second !== undefined) obj.msg = second;
  return obj;
}
const log = {
  info: (obj: any, msg?: string) => console.log(JSON.stringify(logEntry('info', obj, msg))),
  warn: (obj: any, msg?: string) => console.warn(JSON.stringify(logEntry('warn', obj, msg))),
  error: (obj: any, msg?: string) => console.error(JSON.stringify(logEntry('error', obj, msg))),
  debug: (obj: any, msg?: string) => console.debug(JSON.stringify(logEntry('debug', obj, msg))),
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

    this.bot.command('register', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      const groups = this.opts.registeredGroups();

      if (groups[chatJid]) {
        ctx.reply('This chat is already registered.');
        return;
      }

      if (Object.keys(groups).length > 0) {
        ctx.reply('A main chat is already registered. Additional chats can only be added by the main group\'s agent.');
        return;
      }

      if (typeof this.opts.registerGroup !== 'function') {
        ctx.reply('Registration is not available in this deployment.');
        return;
      }

      this.opts.registerGroup(chatJid, {
        name: chatName,
        folder: 'main',
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: true,
      });

      log.info({ chatJid, chatName }, 'Main chat registered via /register command');
      ctx.reply(`Registered! I'm ${ASSISTANT_NAME} — send me a message.`);
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
          const groupCount = Object.keys(this.opts.registeredGroups()).length;
          if (groupCount === 0) {
            console.log(`  No chats registered — send /register to the bot to set up your main chat\n`);
          } else {
            console.log(`  ${groupCount} chat(s) registered — send /chatid to get a chat's registration ID\n`);
          }
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
