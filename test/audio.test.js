import test from 'node:test';
import assert from 'node:assert/strict';
import { twilioToGemini, GeminiToTwilio, linearToMulawSample } from '../src/audio.js';

test('μ-law -> PCM16 16 kHz duplica las muestras y conserva la forma', () => {
  // seno de 400 Hz a 8 kHz codificado en μ-law
  const n = 160;
  const mulaw = Buffer.alloc(n);
  for (let i = 0; i < n; i++) mulaw[i] = linearToMulawSample(Math.round(8000 * Math.sin((2 * Math.PI * 400 * i) / 8000)));
  const pcm = twilioToGemini(mulaw.toString('base64'));
  assert.equal(pcm.length, n * 4);
  let max = 0;
  for (let i = 0; i < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  assert.ok(max > 7000 && max < 9000, `amplitud ${max}`);
});

test('PCM16 24 kHz -> μ-law 8 kHz reduce a la tercera parte y admite trozos partidos', () => {
  const samples = 2400; // 100 ms a 24 kHz
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 24000)), i * 2);
  const one = new GeminiToTwilio().push(pcm);
  assert.equal(one.length, 800);
  // mismo audio en trozos de tamaño raro: el resultado debe ser idéntico
  const g = new GeminiToTwilio();
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1001) parts.push(g.push(pcm.subarray(i, i + 1001)));
  assert.deepEqual(Buffer.concat(parts), one);
});

test('silencio se mantiene como silencio', () => {
  const out = new GeminiToTwilio().push(Buffer.alloc(600));
  assert.ok([...out].every((b) => b === 0xff || b === 0x7f));
});
