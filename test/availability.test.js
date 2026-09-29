import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAvailability, slotsForDay } from '../src/availability.js';
import { loadBusiness } from '../src/config.js';

const cfg = loadBusiness();
const now = { date: '2026-09-28', time: '10:00' }; // lunes
const none = [];

test('lunes cerrado', () => {
  const r = checkAvailability(cfg, none, { date: '2026-10-05', time: '14:00', party_size: 2 }, now);
  assert.equal(r.reason, 'cerrado');
});

test('hueco libre', () => {
  const r = checkAvailability(cfg, none, { date: '2026-10-02', time: '14:00', party_size: 4 }, now);
  assert.equal(r.available, true);
});

test('fuera de horario ofrece alternativas', () => {
  const r = checkAvailability(cfg, none, { date: '2026-10-02', time: '18:00', party_size: 4 }, now);
  assert.equal(r.available, false);
  assert.ok(r.alternatives.length > 0);
});

test('completo por aforo ofrece otras horas', () => {
  const full = [{ status: 'confirmada', date: '2026-10-02', time: '14:00', party_size: 40 }];
  const r = checkAvailability(cfg, full, { date: '2026-10-02', time: '14:00', party_size: 2 }, now);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'completo');
  assert.ok(!r.alternatives.includes('14:00'));
});

test('reserva cancelada no ocupa sitio', () => {
  const b = [{ status: 'cancelada', date: '2026-10-02', time: '14:00', party_size: 40 }];
  assert.equal(checkAvailability(cfg, b, { date: '2026-10-02', time: '14:00', party_size: 2 }, now).available, true);
});

test('grupo grande, fecha pasada y demasiado pronto', () => {
  assert.equal(checkAvailability(cfg, none, { date: '2026-10-02', time: '14:00', party_size: 12 }, now).reason, 'grupo_grande');
  assert.equal(checkAvailability(cfg, none, { date: '2026-09-20', time: '14:00', party_size: 2 }, now).reason, 'fecha_pasada');
  const tue = { date: '2026-09-29', time: '13:30' };
  assert.equal(checkAvailability(cfg, none, { date: '2026-09-29', time: '14:00', party_size: 2 }, tue).reason, 'muy_pronto');
});

test('franjas del día', () => {
  const s = slotsForDay(cfg, '2026-10-02');
  assert.equal(s[0], '13:00');
  assert.ok(s.includes('21:30'));
});
