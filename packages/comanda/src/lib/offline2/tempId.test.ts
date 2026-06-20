import { describe, it, expect } from 'vitest';
import { uuidToTempId } from './tempId';

describe('uuidToTempId', () => {
  it('es determinístico (mismo uuid → mismo tempId)', () => {
    const u = '11111111-2222-3333-4444-555555555555';
    expect(uuidToTempId(u)).toBe(uuidToTempId(u));
  });

  it('siempre devuelve un entero negativo distinto de 0', () => {
    for (let i = 0; i < 1000; i++) {
      const t = uuidToTempId(crypto.randomUUID());
      expect(t).toBeLessThan(0);
      expect(Number.isInteger(t)).toBe(true);
    }
  });

  it('no colisiona en una muestra grande de uuids', () => {
    const vistos = new Set<number>();
    for (let i = 0; i < 5000; i++) vistos.add(uuidToTempId(crypto.randomUUID()));
    // tolerancia mínima: a lo sumo unas pocas colisiones en 5000 (hash 31-bit)
    expect(vistos.size).toBeGreaterThan(4995);
  });
});
