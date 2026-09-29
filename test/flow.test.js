// Prueba de extremo a extremo con un "OpenAI" y un "Twilio" simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asistente-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = 'test';
process.env.VOICE_PROVIDER = 'openai';
process.env.TWILIO_AUTH_TOKEN = 'secreto';
process.env.STREAM_SECRET = 'secreto';
process.env.VALIDATE_TWILIO = 'false';
process.env.ADMIN_PASSWORD = 'pw';

import { nowIn, weekday } from '../src/availability.js';
function nextFriday() {
  const d = new Date(Date.now() + 8 * 86400000);
  while (weekday(nowIn('Europe/Madrid', d).date) !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return nowIn('Europe/Madrid', d).date;
}
const BOOK_DATE = nextFriday();

test('llamada completa: audio, reserva y guardado', async () => {
  // OpenAI falso
  const seen = [];
  const fake = http.createServer();
  const fwss = new WebSocketServer({ server: fake });
  await new Promise((r) => fake.listen(0, r));
  process.env.OPENAI_REALTIME_URL = `ws://127.0.0.1:${fake.address().port}`;

  fwss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw);
      seen.push(ev.type);
      if (ev.type === 'response.create' && !ev.response?.instructions?.includes('Saluda') ) return;
      if (ev.type === 'response.create' && ev.response?.instructions?.includes('Saluda')) {
        ws.send(JSON.stringify({ type: 'response.output_audio.delta', item_id: 'i1', delta: 'AAAA' }));
        // el "modelo" reserva una mesa
        ws.send(JSON.stringify({
          type: 'response.function_call_arguments.done', name: 'create_booking', call_id: 'c1',
          arguments: JSON.stringify({ name: 'Ana', phone: '600111222', date: BOOK_DATE, time: '14:00', party_size: 3 }),
        }));
      }
      if (ev.type === 'conversation.item.create') ws._out = JSON.parse(ev.item.output);
      if (ev.type === 'conversation.item.create') seen.push('OUT:' + ev.item.output);
    });
  });

  const { server } = await import('../src/server.js');
  const { streamToken } = await import('../src/twilio.js');
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // TwiML
  const res = await fetch(`http://127.0.0.1:${port}/incoming-call`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'CallSid=CA123&From=%2B34600111222',
  });
  const xml = await res.text();
  assert.match(xml, /<Stream url="wss?:\/\/.+\/media-stream"/);
  assert.match(xml, /name="token"/);

  // Twilio falso
  const twilio = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  const got = [];
  twilio.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => twilio.on('open', r));
  twilio.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA123', customParameters: { token: streamToken('CA123'), from: '+34600111222' } } }));
  await new Promise((r) => setTimeout(r, 400));
  twilio.send(JSON.stringify({ event: 'media', media: { timestamp: '20', payload: 'BBBB' } }));
  await new Promise((r) => setTimeout(r, 200));
  twilio.send(JSON.stringify({ event: 'stop' }));
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(got.some((m) => m.event === 'media' && m.media.payload === 'AAAA'), 'el audio de la IA llega a Twilio');
  assert.ok(seen.includes('session.update'));
  assert.ok(seen.includes('input_audio_buffer.append'), 'el audio del cliente llega a la IA');
  assert.ok(seen.some((s) => s.startsWith('OUT:') && s.includes('"ok":true')), 'la herramienta responde ok');

  const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
  assert.equal(data.bookings.length, 1);
  assert.equal(data.bookings[0].name, 'Ana');
  assert.equal(data.calls.length, 1);

  // Panel protegido
  assert.equal((await fetch(`http://127.0.0.1:${port}/admin`)).status, 401);
  const ok = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { Authorization: 'Basic ' + Buffer.from('x:pw').toString('base64') } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Ana/);

  // Token de stream inválido se rechaza
  const bad = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  await new Promise((r) => bad.on('open', r));
  const closed = new Promise((r) => bad.on('close', r));
  bad.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ2', callSid: 'CA999', customParameters: { token: 'falso' } } }));
  await closed;

  for (const c of fwss.clients) c.terminate();
  server.closeAllConnections?.(); fake.closeAllConnections?.();
  server.close(); fake.close(); fwss.close();
});
