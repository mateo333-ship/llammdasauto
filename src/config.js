import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function loadBusiness() {
  const file = process.env.BUSINESS_CONFIG || path.join(root, 'config', 'restaurant.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const env = {
  port: Number(process.env.PORT || 5050),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  openaiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
  realtimeUrl: process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime',
  twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
  streamSecret: process.env.STREAM_SECRET || process.env.TWILIO_AUTH_TOKEN || 'cambia-esto',
  validateTwilio: (process.env.VALIDATE_TWILIO || 'true') === 'true',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  maxCallSeconds: Number(process.env.MAX_CALL_SECONDS || 300),
  transcribe: (process.env.TRANSCRIBE || 'true') === 'true',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  vadSilenceMs: Number(process.env.VAD_SILENCE_MS || 600),
};
