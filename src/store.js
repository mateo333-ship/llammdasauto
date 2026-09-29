import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from './config.js';

// Almacén sencillo en un archivo JSON. Para producción con varios servidores,
// cámbialo por una base de datos (Postgres, Supabase...). En Railway/Render
// monta un volumen en DATA_DIR para que los datos no se pierdan al reiniciar.

function file() {
  fs.mkdirSync(env.dataDir, { recursive: true });
  return path.join(env.dataDir, 'data.json');
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { bookings: [], calls: [] };
  }
}

function write(data) {
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file());
}

export function listBookings() {
  return read().bookings;
}

export function addBooking(b) {
  const data = read();
  const booking = { id: crypto.randomUUID().slice(0, 8), status: 'confirmada', created_at: new Date().toISOString(), ...b };
  data.bookings.push(booking);
  write(data);
  return booking;
}

export function cancelBooking(id) {
  const data = read();
  const b = data.bookings.find((x) => x.id === id);
  if (!b) return null;
  b.status = 'cancelada';
  write(data);
  return b;
}

export function addCall(call) {
  const data = read();
  data.calls.push(call);
  data.calls = data.calls.slice(-500);
  write(data);
}

export function listCalls() {
  return read().calls;
}
