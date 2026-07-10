import { describe, it, expect } from 'vitest';
import { APPS } from './lib/apps';
import { TODOS_LOS_PERMISOS, permisoDef } from './lib/permisos';

describe('accesos scaffold', () => {
  it('catálogo de apps tiene las 6 del ecosistema', () => {
    const keys = APPS.map((a) => a.key).sort();
    expect(keys).toEqual(['accesos', 'comanda', 'habitue', 'instagram', 'mesa', 'pase']);
  });
  it('cada app declara su tier (dos mundos)', () => {
    expect(APPS.every((a) => a.tier === 'administrativa' || a.tier === 'operativa')).toBe(true);
    expect(APPS.filter((a) => a.tier === 'operativa').map((a) => a.key).sort()).toEqual(['comanda', 'mesa']);
  });
  it('catálogo de permisos no está vacío y resuelve por slug', () => {
    expect(TODOS_LOS_PERMISOS.length).toBeGreaterThan(10);
    expect(permisoDef('caja')?.label).toBeDefined();
    expect(permisoDef('zzz_nope')).toBeNull();
  });
});
