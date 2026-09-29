import crypto from 'node:crypto';
import { env } from './config.js';

// Firma de Twilio para comprobar que la petición viene realmente de Twilio.
export function validTwilioSignature(url, params, signature) {
  if (!signature || !env.twilioToken) return false;
  const data = url + Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], '');
  const expected = crypto.createHmac('sha1', env.twilioToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Token que se manda en el TwiML y se comprueba al abrirse el WebSocket,
// para que nadie más pueda conectarse a /media-stream y gastar tu saldo.
export function streamToken(callSid) {
  return crypto.createHmac('sha256', env.streamSecret).update(String(callSid)).digest('hex').slice(0, 32);
}

export function validStreamToken(callSid, token) {
  const expected = streamToken(callSid);
  return typeof token === 'string' && token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function connectTwiML(wsUrl, params) {
  const p = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(wsUrl)}">${p}</Stream></Connect></Response>`;
}

// Modifica una llamada en curso (colgar o transferir) mediante la API REST de Twilio.
async function updateCall(callSid, form) {
  if (!env.twilioSid || !env.twilioToken || !callSid) return false;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.twilioSid}/Calls/${callSid}.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${env.twilioSid}:${env.twilioToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  });
  return res.ok;
}

export const hangupCall = (callSid) => updateCall(callSid, { Status: 'completed' });

export const transferCall = (callSid, number) =>
  updateCall(callSid, { Twiml: `<Response><Dial>${xmlEscape(number)}</Dial></Response>` });
