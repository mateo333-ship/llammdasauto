import { WebSocket } from 'ws';
import { env } from './config.js';
import { buildInstructions } from './prompt.js';
import { toolDefinitions, runTool } from './tools.js';
import * as store from './store.js';
import { validStreamToken, hangupCall, transferCall } from './twilio.js';
import { twilioToGemini, GeminiToTwilio } from './audio.js';

// Convierte las herramientas al formato de Gemini (tipos en mayúsculas, sin campos vacíos).
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (out.type) out.type = String(out.type).toUpperCase();
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (Array.isArray(out.required) && out.required.length === 0) delete out.required;
  return out;
}

export const geminiFunctionDeclarations = toolDefinitions.map((t) => {
  const hasParams = t.parameters?.properties && Object.keys(t.parameters.properties).length > 0;
  return {
    name: t.name,
    description: t.description,
    ...(hasParams ? { parameters: toGeminiSchema(t.parameters) } : {}),
  };
});

export function handleGeminiCall(twilioWs, cfg) {
  let streamSid = null;
  let callSid = null;
  let callerPhone = '';
  let started = Date.now();
  let startedAt = new Date().toISOString();
  let outcome = 'completada';
  let hangupAfterTurn = false;
  let maxTimer = null;
  let closed = false;
  let geminiReady = false;
  let geminiWs = null;
  let lastModelAudioAt = 0;
  let userBuf = '';
  let modelBuf = '';
  const transcript = [];
  const downsampler = new GeminiToTwilio();

  const sendTwilio = (obj) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(JSON.stringify(obj));
  const sendGemini = (obj) => geminiWs && geminiWs.readyState === WebSocket.OPEN && geminiWs.send(JSON.stringify(obj));

  const flushUser = () => { if (userBuf.trim()) transcript.push({ role: 'user', text: userBuf.trim() }); userBuf = ''; };
  const flushModel = () => { if (modelBuf.trim()) transcript.push({ role: 'assistant', text: modelBuf.trim() }); modelBuf = ''; };

  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(maxTimer);
    flushUser();
    flushModel();
    try {
      store.addCall({
        call_sid: callSid, from: callerPhone, started_at: startedAt,
        duration_s: Math.round((Date.now() - started) / 1000), outcome, transcript,
      });
    } catch (e) { console.error('No se pudo guardar la llamada', e); }
    if (geminiWs && geminiWs.readyState <= WebSocket.OPEN) geminiWs.close();
    if (twilioWs.readyState <= WebSocket.OPEN) twilioWs.close();
  };

  const endCallNow = async () => {
    const ok = await hangupCall(callSid).catch(() => false);
    if (!ok) finish();
  };

  const actions = {
    hangup: () => { hangupAfterTurn = true; },
    transfer: (reason) => {
      outcome = `transferida: ${reason}`;
      setTimeout(() => transferCall(callSid, cfg.phone_transfer).catch(console.error), 3500);
    },
  };

  function openGemini() {
    const url = new URL(env.geminiUrl);
    url.searchParams.set('key', env.geminiKey);
    geminiWs = new WebSocket(url.toString());

    geminiWs.on('open', () => {
      sendGemini({
        setup: {
          model: `models/${env.geminiModel}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice_gemini || env.geminiVoice } } },
          },
          systemInstruction: { parts: [{ text: buildInstructions(cfg, callerPhone) }] },
          tools: [{ functionDeclarations: geminiFunctionDeclarations }],
          realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: env.vadSilenceMs } },
          ...(env.transcribe ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
        },
      });
    });

    geminiWs.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.setupComplete) {
        geminiReady = true;
        // Gemini no habla hasta que recibe algo: se le pide el saludo inicial.
        sendGemini({ realtimeInput: { text: `Saluda al cliente con esta frase, con naturalidad: "${cfg.greeting}"` } });
        return;
      }

      if (msg.toolCall?.functionCalls) {
        const responses = [];
        for (const fc of msg.toolCall.functionCalls) {
          let result;
          try {
            result = await runTool(fc.name, fc.args || {}, { cfg, callerPhone, actions });
          } catch (e) {
            console.error('Error en herramienta', fc.name, e);
            result = { ok: false, message: 'Error interno; discúlpate y ofrece que llamen más tarde.' };
          }
          responses.push({ id: fc.id, name: fc.name, response: { result } });
        }
        sendGemini({ toolResponse: { functionResponses: responses } });
        // Algunos modelos Live no siguen hablando solos tras una herramienta: si en 1,5 s
        // no ha salido audio, se le pide que continúe.
        const before = lastModelAudioAt;
        setTimeout(() => {
          if (!closed && lastModelAudioAt === before) {
            sendGemini({ realtimeInput: { text: 'Continúa con el cliente usando el resultado de la herramienta.' } });
          }
        }, 1500);
        return;
      }

      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.interrupted) {
        sendTwilio({ event: 'clear', streamSid });
        downsampler.reset();
      }
      if (sc.inputTranscription?.text) userBuf += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) {
        flushUser();
        modelBuf += sc.outputTranscription.text;
      }
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('audio/')) {
          lastModelAudioAt = Date.now();
          const mulaw = downsampler.push(Buffer.from(part.inlineData.data, 'base64'));
          if (mulaw.length && streamSid) {
            sendTwilio({ event: 'media', streamSid, media: { payload: mulaw.toString('base64') } });
          }
        }
      }
      if (sc.turnComplete) {
        flushUser();
        flushModel();
        if (hangupAfterTurn) setTimeout(endCallNow, 2500); // dejar que termine de sonar la despedida
      }
    });

    geminiWs.on('error', (e) => { console.error('WS Gemini:', e.message); outcome = 'error'; finish(); });
    geminiWs.on('close', (code, reason) => {
      if (!closed && code !== 1000) console.error('Gemini cerró la conexión:', code, reason?.toString());
      finish();
    });
  }

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
      maxTimer = setTimeout(() => { outcome = 'cortada por duración máxima'; endCallNow(); }, env.maxCallSeconds * 1000);
      openGemini();
    } else if (msg.event === 'media') {
      if (!geminiReady) return;
      sendGemini({
        realtimeInput: { audio: { data: twilioToGemini(msg.media.payload).toString('base64'), mimeType: 'audio/pcm;rate=16000' } },
      });
    } else if (msg.event === 'stop') {
      finish();
    }
  });

  twilioWs.on('close', finish);
  twilioWs.on('error', (e) => console.error('WS Twilio:', e.message));
}
