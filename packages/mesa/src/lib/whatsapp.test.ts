import { describe, it, expect } from 'vitest';
import { normalizarTelefonoAR, whatsAppUrl, mensajeConfirmacionReserva, mensajeHayMesaWaitlist } from './whatsapp';

describe('normalizarTelefonoAR', () => {
  it('celular de 10 dígitos → 549 + número', () => {
    expect(normalizarTelefonoAR('1156781234')).toBe('5491156781234');
  });

  it('saca el 0 inicial del formato local viejo', () => {
    // 011 5678 1234 → quita 0 → 1156781234 (10) → 549...
    expect(normalizarTelefonoAR('01156781234')).toBe('5491156781234');
  });

  it('número con 54 + 10 dígitos (sin 9) le inserta el 9', () => {
    expect(normalizarTelefonoAR('541156781234')).toBe('5491156781234');
  });

  it('número que ya tiene 549 se deja igual', () => {
    expect(normalizarTelefonoAR('5491156781234')).toBe('5491156781234');
  });

  it('limpia separadores y espacios', () => {
    expect(normalizarTelefonoAR('+54 9 11 5678-1234')).toBe('5491156781234');
  });

  it('vacío o null → null', () => {
    expect(normalizarTelefonoAR('')).toBeNull();
    expect(normalizarTelefonoAR(null)).toBeNull();
    expect(normalizarTelefonoAR(undefined)).toBeNull();
    expect(normalizarTelefonoAR('---')).toBeNull();
  });
});

describe('whatsAppUrl', () => {
  it('arma la URL de wa.me con el mensaje encodeado', () => {
    const url = whatsAppUrl('1156781234', 'Hola che');
    expect(url).toBe('https://wa.me/5491156781234?text=Hola%20che');
  });

  it('sin teléfono válido → null', () => {
    expect(whatsAppUrl('', 'hola')).toBeNull();
    expect(whatsAppUrl(null, 'hola')).toBeNull();
  });

  it('encodea correctamente saltos de línea y asteriscos', () => {
    const url = whatsAppUrl('1156781234', 'Línea 1\n*negrita*');
    expect(url).toContain('%0A');   // newline
    expect(url).toContain('*negrita*'.replace('*', '*')); // asteriscos quedan
  });
});

describe('plantillas de mensaje', () => {
  it('confirmación incluye nombre, local y cantidad de personas', () => {
    const msg = mensajeConfirmacionReserva({
      clienteNombre: 'Ana', localNombre: 'Neko', fechaHora: '2026-06-25T21:00:00-03:00', personas: 2,
    });
    expect(msg).toContain('Ana');
    expect(msg).toContain('Neko');
    expect(msg).toContain('2 personas');
    expect(msg).toContain('Confirmamos');
  });

  it('singular "1 persona" cuando es una sola', () => {
    const msg = mensajeConfirmacionReserva({
      clienteNombre: 'Ana', localNombre: 'Neko', fechaHora: '2026-06-25T21:00:00-03:00', personas: 1,
    });
    expect(msg).toContain('1 persona');
    expect(msg).not.toContain('1 personas');
  });

  it('mensaje de "hay mesa" del waitlist menciona el local y las personas', () => {
    const msg = mensajeHayMesaWaitlist({ clienteNombre: 'Beto', localNombre: 'Neko', personas: 4 });
    expect(msg).toContain('Beto');
    expect(msg).toContain('Neko');
    expect(msg).toContain('4 personas');
  });
});
