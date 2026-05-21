import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CALLERS_FILE = resolve(__dirname, '../../callers.json');

export interface CallerConfig {
  id: string;
  sip_username: string;
  sip_password: string;
  sip_domain: string;
}

export function loadCallers(): CallerConfig[] {
  if (!existsSync(CALLERS_FILE)) return [];
  return JSON.parse(readFileSync(CALLERS_FILE, 'utf-8')) as CallerConfig[];
}

export const callers = loadCallers();
