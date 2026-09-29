// Llamada completa con un "Gemini" y un "Twilio" simulados.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { nowIn, weekday } from '../src/availability.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asistente-g-'));
process.env.DATA_DIR = dataDir;
process.env.VOICE_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'clave-test';
process.env.STREAM_SECRET = 'secreto';
process.env.VALIDATE_TWILIO = 'false';

function nextFriday() {
  const d = new Date(Date.now() + 8 * 86400000);
  while (weekday(nowIn('Europe/Madrid', d).date) !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return nowIn('Europe/Madrid', d).date;
}

test('Gemini: setup, audio de ida y vuelta, herramienta y guardado', async () => {
  const seen = [];
  let setupMsg = null;
  let url = '';
  const fake = http.createServer();
  const fwss = new WebSocketServer({ server: fake });
  await new Promise((r) => fake.listen(0, r));
  process.env.GEMINI_LIVE_URL = `ws://127.0.0.1:${fake.address().port}/live`;

  fwss.on('connection', (ws, req) => {
    url = req.url;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.setup) { setupMsg = m.setup; ws.send(JSON.stringify({ setupComplete: {} })); return; }
      if (m.realtimeInput?.text?.includes('Saluda')) {
        seen.push('greet');
        const pcm = Buffer.alloc(4800); // 100 ms a 24 kHz
        ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] } } }));
        ws.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Hola, ¿en qué ' } } }));
        ws.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'puedo ayudarte?' }, turnComplete: true } }));
        ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'f1', name: 'create_booking', args: { name: 'Ana', phone: '600111222', date: nextFriday(), time: '14:00', party_size: 3 } }] } }));
      }
      if (m.realtimeInput?.audio) seen.push('audio:' + m.realtimeInput.audio.mimeType);
      if (m.toolResponse) seen.push('tool:' + JSON.stringify(m.toolResponse.functionResponses[0].response));
    });
  });

  const { server } = await import('../src/server.js');
  const { streamToken } = await import('../src/twilio.js');
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const twilio = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
  const got = [];
  twilio.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => twilio.on('open', r));
  twilio.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { token: streamToken('CA1'), from: '+34600111222' } } }));
  await new Promise((r) => setTimeout(r, 400));
  twilio.send(JSON.stringify({ event: 'media', media: { timestamp: '20', payload: Buffer.alloc(160, 0xff).toString('base64') } }));
  await new Promise((r) => setTimeout(r, 300));
  twilio.send(JSON.stringify({ event: 'stop' }));
  await new Promise((r) => setTimeout(r, 300));

  assert.match(url, /key=clave-test/);
  assert.equal(setupMsg.model, 'models/gemini-3.8-live');
  assert.deepEqual(setupMsg.generationConfig.responseModalities, ['AUDIO']);
  assert.match(setupMsg.systemInstruction.parts[0].text, /Restaurante La Plaza/);
  const decl = setupMsg.tools[0].functionDeclarations;
  assert.equal(decl.length, 6);
  assert.equal(decl.find((d) => d.name === 'check_availability').parameters.type, 'OBJECT');
  assert.equal(decl.find((d) => d.name === 'end_call').parameters, undefined);

  assert.ok(seen.includes('greet'));
  assert.ok(seen.includes('audio:audio/pcm;rate=16000'), 'el audio del cliente llega a Gemini');
  assert.ok(got.some((m) => m.event === 'media' && Buffer.from(m.media.payload, 'base64').length === 800), 'el audio de Gemini llega a Twilio en μ-law 8 kHz');
  assert.ok(seen.some((s) => s.startsWith('tool:') && s.includes('"ok":true')), 'la herramienta responde ok');

  const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
  assert.equal(data.bookings.length, 1);
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].transcript[0].text, 'Hola, ¿en qué puedo ayudarte?');

  for (const c of fwss.clients) c.terminate();
  server.closeAllConnections?.(); fake.closeAllConnections?.();
  server.close(); fake.close(); fwss.close();
});
