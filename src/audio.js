// Conversión de audio entre Twilio (μ-law 8 kHz) y Gemini (PCM 16-bit: 16 kHz entrada, 24 kHz salida).

const BIAS = 0x84;
const CLIP = 32635;

const MULAW_TO_LINEAR = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  MULAW_TO_LINEAR[i] = sign ? -sample : sample;
}

export function linearToMulawSample(sample) {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Twilio (base64 μ-law 8 kHz) -> Buffer PCM16 little-endian a 16 kHz
export function twilioToGemini(base64Mulaw) {
  const mulaw = Buffer.from(base64Mulaw, 'base64');
  const n = mulaw.length;
  const out = Buffer.alloc(n * 4); // 2 muestras de 16 bits por cada muestra de entrada
  for (let i = 0; i < n; i++) {
    const a = MULAW_TO_LINEAR[mulaw[i]];
    const b = i + 1 < n ? MULAW_TO_LINEAR[mulaw[i + 1]] : a;
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE((a + b) >> 1, i * 4 + 2); // interpolación lineal
  }
  return out;
}

// Gemini (PCM16 24 kHz) -> μ-law 8 kHz. Es "con estado" porque los trozos de audio
// pueden cortar una muestra o un grupo de 3 muestras por la mitad.
export class GeminiToTwilio {
  constructor() {
    this.carry = Buffer.alloc(0);
  }

  push(pcmBuffer) {
    const buf = Buffer.concat([this.carry, pcmBuffer]);
    const groupBytes = 6; // 3 muestras de 2 bytes = 1 muestra a 8 kHz
    const usable = buf.length - (buf.length % groupBytes);
    this.carry = buf.subarray(usable);
    const out = Buffer.alloc(usable / groupBytes);
    for (let i = 0, o = 0; i < usable; i += groupBytes, o++) {
      const avg = (buf.readInt16LE(i) + buf.readInt16LE(i + 2) + buf.readInt16LE(i + 4)) / 3;
      out[o] = linearToMulawSample(Math.round(avg));
    }
    return out;
  }

  reset() {
    this.carry = Buffer.alloc(0);
  }
}
