import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import type { NewMessageEvent } from 'telegram/events/NewMessage.js';
import { env, callers, sources } from '../config/index.js';
import { logger } from '../utils/index.js';
import { ringViaSip, sendSipMessage } from './sipCallService.js';

// EVM: 0x + 40 hex chars
const EVM_REGEX = /\b0x[a-fA-F0-9]{40}\b/g;
// Solana: base58, 43-44 chars
const SOLANA_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g;

function extractTokenAddresses(text: string): string[] {
  const evm = text.match(EVM_REGEX) ?? [];
  const solana = text.match(SOLANA_REGEX) ?? [];
  return [...new Set([...evm, ...solana])];
}

const lastCallTimes = new Map<string, number>();

function isInCooldown(chatId: string, cooldown_ms: number): boolean {
  return Date.now() - (lastCallTimes.get(chatId) ?? 0) < cooldown_ms;
}

function getRemainingSeconds(chatId: string, cooldown_ms: number): number {
  return Math.ceil((cooldown_ms - (Date.now() - (lastCallTimes.get(chatId) ?? 0))) / 1000);
}

let client: TelegramClient | null = null;

async function handleMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;
  const text = message.text ?? message.message ?? '';
  if (!text) return;

  const chatId = message.chatId?.toString() ?? '';
  const entry = sources.telegram.find(e => e.chat_id === chatId);
  if (!entry) return;

  const addresses = extractTokenAddresses(text);
  if (addresses.length === 0) return;

  logger.info({ addresses, chat: entry.name, caller: entry.caller }, 'Token address(es) detected in Telegram');

  if (isInCooldown(chatId, entry.cooldown_ms)) {
    logger.debug(
      { remaining: getRemainingSeconds(chatId, entry.cooldown_ms), chat: chatId },
      'Token detected — call skipped (cooldown)',
    );
    return;
  }

  lastCallTimes.set(chatId, Date.now());

  const caller = callers.find(c => c.id === entry.caller);
  if (!caller) {
    logger.warn({ callerId: entry.caller, chat: chatId }, 'Caller config not found in callers.json');
    return;
  }

  const [, callResult] = await Promise.all([
    sendSipMessage(`[Telegram/${caller.id}] Token detected:\n${addresses.join('\n')}`, caller),
    ringViaSip(caller),
  ]);

  if (!callResult.success) {
    logger.error({ error: callResult.error, caller: caller.id }, 'Telegram-triggered call failed');
  }
}

export async function startTelegramTracker(): Promise<void> {
  const { TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION } = env;

  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_SESSION) {
    logger.warn('Telegram tracker disabled — TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION not set');
    return;
  }

  if (sources.telegram.length === 0) {
    logger.warn('Telegram tracker disabled — no telegram entries in sources.json');
    return;
  }

  client = new TelegramClient(
    new StringSession(TELEGRAM_SESSION),
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    { connectionRetries: 5 },
  );

  await client.connect();
  logger.info('Telegram client connected');

  const chatIds = sources.telegram.map(e => e.chat_id);
  client.addEventHandler(handleMessage, new NewMessage({ chats: chatIds }));

  logger.info({ chats: chatIds }, 'Telegram tracker listening');
}

export async function stopTelegramTracker(): Promise<void> {
  if (client) {
    await client.disconnect();
    logger.info('Telegram client disconnected');
  }
}
