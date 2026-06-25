import { describe, it, expect } from 'vitest';
import { APPS } from './lib/apps';
import { TODOS_LOS_PERMISOS, permisoDef } from './lib/permisos';

describe('equipo scaffold', () => {
  it('catálogo de apps tiene las 5 del ecosistema', () => {
    const keys = APPS.map((a) => a.key).sort();
    expect(keys).toEqual(['comanda', 'equipo', 'habitue', 'mesa', 'pase']);
  });
  it('catálogo de permisos no está vacío y resuelve por slug', () => {
    expect(TODOS_LOS_PERMISOS.length).toBeGreaterThan(10);
    expect(permisoDef('caja')?.label).toBeDefined();
    expect(permisoDef('zzz_nope')).toBeNull();
  });
});
