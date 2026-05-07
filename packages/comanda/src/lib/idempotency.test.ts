import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey } from './idempotency';

// Tests del hook useIdempotencyKey requieren @testing-library/react que NO
// está instalado. Por la regla "no agregar deps", testeamos solo la
// función puramente síncrona generateIdempotencyKey aquí. La verificación
// del hook se hace via tests integration (en services/sprint7.test.ts
// se verifica que los services pasan el key generado correctamente).

describe('generateIdempotencyKey', () => {
  it('genera un UUID v4 válido', () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('cada llamada da un UUID distinto', () => {
    const k1 = generateIdempotencyKey();
    const k2 = generateIdempotencyKey();
    expect(k1).not.toBe(k2);
  });

  it('100 llamadas dan 100 UUIDs únicos', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i += 1) keys.add(generateIdempotencyKey());
    expect(keys.size).toBe(100);
  });
});
