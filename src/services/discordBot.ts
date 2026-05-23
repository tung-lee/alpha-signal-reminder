import { Client, GatewayIntentBits } from 'discord.js';
import { env, callers, findDiscordChannel } from '../config/index.js';

import { logger } from '../utils/index.js';
import { ringViaSip, sendSipMessage } from './sipCallService.js';

class CallCooldown {
  private lastCallTime = 0;

  isInCooldown(cooldown_ms: number): boolean {
    return Date.now() - this.lastCallTime < cooldown_ms;
  }

  getRemainingSeconds(cooldown_ms: number): number {
    return Math.ceil((cooldown_ms - (Date.now() - this.lastCallTime)) / 1000);
  }

  reset(): void {
    this.lastCallTime = Date.now();
  }
}

const cooldowns = new Map<string, CallCooldown>();

function getCooldown(channelId: string): CallCooldown {
  if (!cooldowns.has(channelId)) cooldowns.set(channelId, new CallCooldown());
  return cooldowns.get(channelId)!;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  logger.info({ tag: client.user?.tag }, 'Discord bot connected');
});

client.on('messageCreate', async (message) => {
  const channel = findDiscordChannel(message.guildId, message.channelId);
  if (!channel) return;

  const caller = callers.find(c => c.id === channel.caller);
  if (!caller) {
    logger.warn({ callerId: channel.caller, guild: message.guildId, channel: message.channelId }, 'Caller config not found in callers.json');
    return;
  }

  const cooldown = getCooldown(message.channelId);
  if (cooldown.isInCooldown(channel.cooldown_ms)) {
    logger.debug(
      { remaining: cooldown.getRemainingSeconds(channel.cooldown_ms), caller: caller.id, channel: message.channelId },
      'Discord message received — call skipped (cooldown)',
    );
    return;
  }

  cooldown.reset();
  logger.info(
    { channel: channel.name, caller: caller.id, author: message.author.tag },
    'Discord message — triggering call',
  );

  let preview = message.content;
  if (!preview && message.embeds.length > 0) {
    const embed = message.embeds[0];
    const parts = [embed.title, embed.description, ...embed.fields.map(f => `${f.name}: ${f.value}`)].filter(Boolean);
    preview = parts.join(' | ');
  }
  preview = preview.slice(0, 200);

  const callResult = await ringViaSip(caller);
  sendSipMessage(`[Discord/${caller.id}] ${message.author.tag}: ${preview}`, caller);


  if (!callResult.success) {
    logger.error({ error: callResult.error, caller: caller.id }, 'Discord-triggered call failed');
  }
});

export function startDiscordBot(): void {
  client.login(env.DISCORD_BOT_TOKEN).catch((err) => {
    logger.error({ err }, 'Failed to connect Discord bot');
  });
}

export function stopDiscordBot(): void {
  client.destroy();
  logger.info('Discord bot disconnected');
}
