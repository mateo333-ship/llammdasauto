import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { env, loadBusiness } from './config.js';
import { buildInstructions } from './prompt.js';
import { toolDefinitions, runTool } from './tools.js';
import * as store from './store.js';
import { connectTwiML, streamToken, validStreamToken, validTwilioSignature, hangupCall, transferCall } from './twilio.js';

const cfg = loadBusiness();
const app = express();
app.use(express.urlencoded({ extended: false }));

const publicBase = (req) => env.publicUrl || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

app.get('/health', (_req, res) => res.json({ ok: true, business: cfg.name }));

// Twilio llama aquí cuando entra una llamada al número.
app.post('/incoming-call', (req, res) => {
  const base = publicBase(req);
  if (env.validateTwilio && env.twilioToken) {
    const ok = validTwilioSignature(`${base}/incoming-call`, req.body, req.headers['x-twilio-signature']);
    if (!ok) return res.status(403).send('Firma de Twilio no válida');
  }
  const callSid = req.body.CallSid || '';
  const wsUrl = base.replace(/^http/, 'ws') + '/media-stream';
  res.type('text/xml').send(connectTwiML(wsUrl, {
    token: streamToken(callSid),
    from: req.body.From || '',
  }));
});

// ---------- Panel sencillo para el dueño ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function adminAuth(req, res, next) {
  if (!env.adminPassword) return res.status(503).send('Define ADMIN_PASSWORD para activar el panel.');
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    const a = crypto.createHash('sha256').update(pass).digest();
    const b = crypto.createHash('sha256').update(env.adminPassword).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Panel"').status(401).send('Acceso restringido');
}

app.get('/admin', adminAuth, (_req, res) => {
  const bookings = store.listBookings().slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const calls = store.listCalls().slice().reverse().slice(0, 50);
  res.send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.name)} · Panel</title>
<style>body{font:15px system-ui;margin:24px;max-width:1000px}table{border-collapse:collapse;width:100%;margin:12px 0 32px}
th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#f6f6f6}.c{color:#b00}details{margin:4px 0}</style>
<h1>${esc(cfg.name)}</h1>
<h2>Reservas (${bookings.length})</h2>
<table><tr><th>Fecha</th><th>Hora</th><th>Pers.</th><th>Nombre</th><th>Teléfono</th><th>Notas</th><th>Estado</th></tr>
${bookings.map((b) => `<tr><td>${esc(b.date)}</td><td>${esc(b.time)}</td><td>${esc(b.party_size)}</td><td>${esc(b.name)}</td><td>${esc(b.phone)}</td><td>${esc(b.notes)}</td><td class="${b.status === 'cancelada' ? 'c' : ''}">${esc(b.status)}</td></tr>`).join('')}</table>
<h2>Últimas llamadas</h2>
<table><tr><th>Inicio</th><th>De</th><th>Duración</th><th>Resultado</th><th>Transcripción</th></tr>
${calls.map((c) => `<tr><td>${esc(c.started_at)}</td><td>${esc(c.from)}</td><td>${esc(c.duration_s)} s</td><td>${esc(c.outcome)}</td>
<td><details><summary>Ver</summary>${(c.transcript || []).map((t) => `<div><b>${t.role === 'user' ? 'Cliente' : 'Asistente'}:</b> ${esc(t.text)}</div>`).join('')}</details></td></tr>`).join('')}</table>
</html>`);
});

app.get('/admin/data.json', adminAuth, (_req, res) => res.json({ bookings: store.listBookings(), calls: store.listCalls() }));

// ---------- Puente Twilio <-> OpenAI Realtime ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/media-stream') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let callerPhone = '';
  let latestMediaTs = 0;
  let responseStartTs = null;
  let lastAssistantItem = null;
  let started = Date.now();
  let startedAt = new Date().toISOString();
  let outcome = 'completada';
  let hangupAfterResponse = false;
  let maxTimer = null;
  let closed = false;
  const transcript = [];
  const pendingTool = new Set();

  const q = new URL(`${env.realtimeUrl}`);
  q.searchParams.set('model', env.model);
  const openaiWs = new WebSocket(q.toString(), { headers: { Authorization: `Bearer ${env.openaiKey}` } });
  const sendAI = (obj) => openaiWs.readyState === WebSocket.OPEN && openaiWs.send(JSON.stringify(obj));
  const sendTwilio = (obj) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(JSON.stringify(obj));

  let aiReady = false;
  let twilioReady = false;
  const maybeGreet = () => {
    if (!(aiReady && twilioReady)) return;
    // Prompt definitivo (necesita el teléfono de quien llama) y saludo inicial.
    sendAI({ type: 'session.update', session: { type: 'realtime', instructions: buildInstructions(cfg, callerPhone) } });
    sendAI({
      type: 'response.create',
      response: { instructions: `Saluda al cliente con esta frase, con naturalidad: "${cfg.greeting}"` },
    });
  };

  const finish = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(maxTimer);
    try {
      store.addCall({
        call_sid: callSid, from: callerPhone, started_at: startedAt,
        duration_s: Math.round((Date.now() - started) / 1000), outcome, transcript,
      });
    } catch (e) { console.error('No se pudo guardar la llamada', e); }
    if (openaiWs.readyState <= WebSocket.OPEN) openaiWs.close();
    if (twilioWs.readyState <= WebSocket.OPEN) twilioWs.close();
  };

  const endCallNow = async () => {
    const ok = await hangupCall(callSid).catch(() => false);
    if (!ok) finish(); // sin credenciales REST, cerrar el stream termina la llamada
  };

  const actions = {
    hangup: () => { hangupAfterResponse = true; },
    transfer: (reason) => {
      outcome = `transferida: ${reason}`;
      setTimeout(() => transferCall(callSid, cfg.phone_transfer).catch(console.error), 3500);
    },
  };

  openaiWs.on('open', () => {
    sendAI({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: env.model,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: { type: 'server_vad', silence_duration_ms: env.vadSilenceMs },
            ...(env.transcribe ? { transcription: { model: env.transcribeModel, language: 'es' } } : {}),
          },
          output: { format: { type: 'audio/pcmu' }, voice: cfg.voice || 'marin' },
        },
        tools: toolDefinitions,
        tool_choice: 'auto',
      },
    });
    aiReady = true;
    maybeGreet();
  });

  openaiWs.on('message', async (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    switch (ev.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!streamSid || !ev.delta) break;
        sendTwilio({ event: 'media', streamSid, media: { payload: ev.delta } });
        if (responseStartTs === null) responseStartTs = latestMediaTs;
        if (ev.item_id) lastAssistantItem = ev.item_id;
        sendTwilio({ event: 'mark', streamSid, mark: { name: 'r' } });
        break;
      }

      case 'input_audio_buffer.speech_started': {
        // El cliente interrumpe: cortar el audio pendiente y recortar lo que dijo la IA.
        if (lastAssistantItem && responseStartTs !== null) {
          const elapsed = Math.max(0, latestMediaTs - responseStartTs);
          sendAI({ type: 'conversation.item.truncate', item_id: lastAssistantItem, content_index: 0, audio_end_ms: elapsed });
        }
        sendTwilio({ event: 'clear', streamSid });
        lastAssistantItem = null;
        responseStartTs = null;
        break;
      }

      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) transcript.push({ role: 'user', text: ev.transcript.trim() });
        break;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (ev.transcript?.trim()) transcript.push({ role: 'assistant', text: ev.transcript.trim() });
        break;

      case 'response.function_call_arguments.done': {
        pendingTool.add(ev.call_id);
        let args = {};
        try { args = JSON.parse(ev.arguments || '{}'); } catch { /* argumentos vacíos */ }
        let result;
        try {
          result = await runTool(ev.name, args, { cfg, callerPhone, actions });
        } catch (e) {
          console.error('Error en herramienta', ev.name, e);
          result = { ok: false, message: 'Error interno; discúlpate y ofrece que llamen más tarde.' };
        }
        sendAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: JSON.stringify(result) } });
        sendAI({ type: 'response.create' });
        pendingTool.delete(ev.call_id);
        break;
      }

      case 'response.done':
        // Si se pidió colgar, esperar a que termine de despedirse el audio ya enviado.
        if (hangupAfterResponse && pendingTool.size === 0 && !ev.response?.output?.some((o) => o.type === 'function_call')) {
          setTimeout(endCallNow, 2500);
        }
        break;

      case 'error':
        console.error('Error de OpenAI:', JSON.stringify(ev.error || ev));
        break;
      default:
    }
  });

  twilioWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event === 'start') {
      const cp = msg.start.customParameters || {};
      callSid = msg.start.callSid;
      if (!validStreamToken(callSid, cp.token)) {
        console.warn('Conexión rechazada: token de stream no válido');
        outcome = 'rechazada';
        return finish();
      }
      streamSid = msg.start.streamSid;
      callerPhone = cp.from || '';
      started = Date.now();
      startedAt = new Date().toISOString();
      twilioReady = true;
      maxTimer = setTimeout(() => { outcome = 'cortada por duración máxima'; endCallNow(); }, env.maxCallSeconds * 1000);
      maybeGreet();
    } else if (msg.event === 'media') {
      latestMediaTs = Number(msg.media.timestamp) || latestMediaTs;
      sendAI({ type: 'input_audio_buffer.append', audio: msg.media.payload });
    } else if (msg.event === 'stop') {
      finish();
    }
  });

  twilioWs.on('close', finish);
  openaiWs.on('close', finish);
  openaiWs.on('error', (e) => { console.error('WS OpenAI:', e.message); outcome = 'error'; finish(); });
  twilioWs.on('error', (e) => console.error('WS Twilio:', e.message));
});

export { server };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!env.openaiKey) console.warn('⚠️  Falta OPENAI_API_KEY');
  server.listen(env.port, () => console.log(`Asistente de "${cfg.name}" escuchando en el puerto ${env.port}`));
}
