// Lógica de horarios y disponibilidad. Fechas "YYYY-MM-DD", horas "HH:MM".

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z'));
}

export function isValidTime(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function weekday(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

// Fecha y hora actuales en la zona horaria del negocio.
export function nowIn(tz, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

// Todas las franjas de inicio posibles de ese día.
export function slotsForDay(cfg, dateStr) {
  const ranges = cfg.hours[String(weekday(dateStr))] || [];
  const { slot_minutes, duration_minutes } = cfg.booking;
  const slots = [];
  for (const [open, close] of ranges) {
    // la última reserva debe poder terminar antes de cerrar la cocina/local
    const last = toMinutes(close) - Math.min(duration_minutes, 60);
    for (let t = toMinutes(open); t <= last; t += slot_minutes) slots.push(fromMinutes(t));
  }
  return slots;
}

function seatsUsedAt(cfg, bookings, dateStr, time) {
  const start = toMinutes(time);
  const end = start + cfg.booking.duration_minutes;
  return bookings
    .filter((b) => b.status !== 'cancelada' && b.date === dateStr)
    .filter((b) => {
      const bs = toMinutes(b.time);
      const be = bs + cfg.booking.duration_minutes;
      return bs < end && be > start;
    })
    .reduce((sum, b) => sum + b.party_size, 0);
}

export function checkAvailability(cfg, bookings, { date, time, party_size }, now = nowIn(cfg.timezone)) {
  if (!isValidDate(date)) return { ok: false, reason: 'fecha_invalida', message: 'La fecha debe tener formato AAAA-MM-DD.' };
  if (!isValidTime(time)) return { ok: false, reason: 'hora_invalida', message: 'La hora debe tener formato HH:MM (24 h).' };
  if (!Number.isInteger(party_size) || party_size < 1) return { ok: false, reason: 'personas_invalido', message: 'Número de personas no válido.' };
  if (party_size > cfg.booking.max_party_size) {
    return { ok: false, reason: 'grupo_grande', message: `Para más de ${cfg.booking.max_party_size} personas hay que hablar con una persona del restaurante.` };
  }
  const ahead = daysBetween(now.date, date);
  if (ahead < 0) return { ok: false, reason: 'fecha_pasada', message: 'Esa fecha ya ha pasado.' };
  if (ahead > cfg.booking.max_days_ahead) return { ok: false, reason: 'demasiado_lejos', message: `Solo se puede reservar con hasta ${cfg.booking.max_days_ahead} días de antelación.` };
  if (ahead === 0 && toMinutes(time) < toMinutes(now.time) + cfg.booking.min_advance_minutes) {
    return { ok: false, reason: 'muy_pronto', message: `Hace falta reservar con al menos ${cfg.booking.min_advance_minutes} minutos de antelación.` };
  }

  const slots = slotsForDay(cfg, date);
  if (slots.length === 0) return { ok: false, reason: 'cerrado', message: 'El restaurante está cerrado ese día.' };

  const fits = (t) => seatsUsedAt(cfg, bookings, date, t) + party_size <= cfg.booking.capacity_seats;
  const notPast = (t) => !(ahead === 0 && toMinutes(t) < toMinutes(now.time) + cfg.booking.min_advance_minutes);

  if (slots.includes(time) && fits(time)) return { ok: true, available: true, date, time, party_size };

  const alternatives = slots
    .filter((t) => fits(t) && notPast(t))
    .sort((a, b) => Math.abs(toMinutes(a) - toMinutes(time)) - Math.abs(toMinutes(b) - toMinutes(time)))
    .slice(0, 3)
    .sort();

  return {
    ok: true,
    available: false,
    reason: slots.includes(time) ? 'completo' : 'fuera_de_horario',
    open_slots_that_day: slots.length ? `${slots[0]} - ${slots[slots.length - 1]}` : null,
    alternatives,
  };
}
