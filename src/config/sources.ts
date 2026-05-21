import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SOURCES_FILE = resolve(__dirname, '../../sources.json');

export interface DiscordChannel {
  id: string;
  name: string;
  caller: string;
  cooldown_ms: number;
}

export interface DiscordEntry {
  guild_id: string;
  name: string;
  channels: DiscordChannel[];
}

export interface TelegramEntry {
  chat_id: string;
  name: string;
  caller: string;
  cooldown_ms: number;
}

export interface Sources {
  discord: DiscordEntry[];
  telegram: TelegramEntry[];
}

function loadSources(): Sources {
  if (!existsSync(SOURCES_FILE)) return { discord: [], telegram: [] };
  const raw = JSON.parse(readFileSync(SOURCES_FILE, 'utf-8')) as Partial<Sources>;
  return {
    discord: raw.discord ?? [],
    telegram: raw.telegram ?? [],
  };
}

export const sources = loadSources();

export function findDiscordChannel(guildId: string | null, channelId: string): DiscordChannel | undefined {
  if (!guildId) return undefined;
  const guild = sources.discord.find(e => e.guild_id === guildId);
  return guild?.channels.find(c => c.id === channelId);
}
