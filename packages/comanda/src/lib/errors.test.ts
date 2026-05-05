import { describe, it, expect } from 'vitest';
import { translateError } from './errors';

describe('translateError', () => {
  it('null/undefined/empty → mensaje genérico', () => {
    expect(translateError(null)).toMatch(/desconocido/);
    expect(translateError(undefined)).toMatch(/desconocido/);
    expect(translateError({})).toMatch(/desconocido/);
  });
  it('códigos conocidos se traducen al castellano', () => {
    expect(translateError({ message: 'SIN_PERMISO_AUMENTO_MASIVO' })).toMatch(/permiso/i);
    expect(translateError({ message: 'ITEM_NO_ENCONTRADO' })).toMatch(/no existe/i);
  });
  it('códigos desconocidos pasan crudos (fallback)', () => {
    expect(translateError({ message: 'UNKNOWN_ERROR_XYZ' })).toBe('UNKNOWN_ERROR_XYZ');
  });
});
