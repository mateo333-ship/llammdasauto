import { checkAvailability, isValidDate, isValidTime } from './availability.js';
import * as store from './store.js';

// Definición de las herramientas que ve el modelo (formato Realtime API GA).
export const toolDefinitions = [
  {
    type: 'function',
    name: 'check_availability',
    description: 'Comprueba si hay mesa libre para una fecha, hora y número de personas. Úsala SIEMPRE antes de confirmar una reserva.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Fecha en formato AAAA-MM-DD' },
        time: { type: 'string', description: 'Hora en formato HH:MM de 24 horas' },
        party_size: { type: 'integer', description: 'Número de personas' },
      },
      required: ['date', 'time', 'party_size'],
    },
  },
  {
    type: 'function',
    name: 'create_booking',
    description: 'Crea la reserva una vez el cliente ha confirmado todos los datos y hay disponibilidad.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre para la reserva' },
        phone: { type: 'string', description: 'Teléfono de contacto' },
        date: { type: 'string', description: 'Fecha AAAA-MM-DD' },
        time: { type: 'string', description: 'Hora HH:MM' },
        party_size: { type: 'integer' },
        notes: { type: 'string', description: 'Alergias, trona, celebración, etc. (opcional)' },
      },
      required: ['name', 'phone', 'date', 'time', 'party_size'],
    },
  },
  {
    type: 'function',
    name: 'find_booking',
    description: 'Busca las reservas activas de un cliente por su teléfono.',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string' } },
      required: ['phone'],
    },
  },
  {
    type: 'function',
    name: 'cancel_booking',
    description: 'Cancela una reserva existente usando su identificador (obtenido con find_booking).',
    parameters: {
      type: 'object',
      properties: { booking_id: { type: 'string' } },
      required: ['booking_id'],
    },
  },
  {
    type: 'function',
    name: 'transfer_to_human',
    description: 'Pasa la llamada a una persona del restaurante. Úsala si el cliente lo pide, si es una queja, un grupo grande o algo que no sabes resolver.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Termina la llamada. Úsala después de despedirte cuando el cliente no necesite nada más.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const digits = (s) => String(s || '').replace(/[^\d+]/g, '');

// ctx: { cfg, callerPhone, actions: { transfer(), hangup() } }
export async function runTool(name, args, ctx) {
  switch (name) {
    case 'check_availability':
      return checkAvailability(ctx.cfg, store.listBookings(), args);

    case 'create_booking': {
      const { name: guest, phone, date, time, party_size } = args;
      if (!guest || !digits(phone)) return { ok: false, message: 'Faltan el nombre o el teléfono.' };
      if (!isValidDate(date) || !isValidTime(time)) return { ok: false, message: 'Fecha u hora no válidas.' };
      // Se vuelve a comprobar por si otro cliente ha reservado mientras tanto.
      const check = checkAvailability(ctx.cfg, store.listBookings(), { date, time, party_size });
      if (!check.ok || !check.available) return { ok: false, message: 'Ya no hay disponibilidad a esa hora.', detail: check };
      const booking = store.addBooking({
        name: guest, phone: digits(phone), date, time, party_size,
        notes: args.notes || '', caller: ctx.callerPhone || '',
      });
      return { ok: true, booking_id: booking.id, message: 'Reserva creada.' };
    }

    case 'find_booking': {
      const p = digits(args.phone);
      const found = store.listBookings()
        .filter((b) => b.status === 'confirmada' && (digits(b.phone).endsWith(p.slice(-9)) || digits(b.caller).endsWith(p.slice(-9))))
        .map((b) => ({ booking_id: b.id, name: b.name, date: b.date, time: b.time, party_size: b.party_size }));
      return { ok: true, bookings: found };
    }

    case 'cancel_booking': {
      const b = store.cancelBooking(args.booking_id);
      return b ? { ok: true, message: 'Reserva cancelada.' } : { ok: false, message: 'No se encuentra esa reserva.' };
    }

    case 'transfer_to_human': {
      if (!ctx.cfg.phone_transfer) {
        return { ok: false, message: 'No hay línea de transferencia. Ofrece al cliente que llame en otro momento o que deje un recado (nombre y teléfono).' };
      }
      ctx.actions.transfer(args.reason);
      return { ok: true, message: 'Transfiriendo. Avisa brevemente al cliente de que le pasas con una persona.' };
    }

    case 'end_call':
      ctx.actions.hangup();
      return { ok: true };

    default:
      return { ok: false, message: `Herramienta desconocida: ${name}` };
  }
}
