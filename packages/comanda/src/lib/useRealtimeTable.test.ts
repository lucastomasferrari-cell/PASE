import { describe, it, expect } from 'vitest';
import { buildRealtimeConfig } from './useRealtimeTable';

// Tests del helper puro buildRealtimeConfig — verifica que el filtro
// PostgREST y el channelName se construyen correctamente para cada
// combinación de opciones.
//
// El comportamiento React del hook (effects, cleanup, debounce, fallback
// polling) NO se testea acá porque requeriría @testing-library/react
// (no instalado). La cobertura de la lógica pura es el bulk del hook.

describe('buildRealtimeConfig — filtro tenant', () => {
  it('default scopeByTenant=true: incluye tenant_id en filtro', () => {
    const config = buildRealtimeConfig({
      table: 'medios_cobro',
      tenantId: 'tenant-uuid-test',
      localId: null,
      scopeByTenant: true,
      scopeByLocal: false,
    });
    expect(config).not.toBeNull();
    expect(config!.filter).toBe('tenant_id=eq.tenant-uuid-test');
    expect(config!.channelName).toBe('rt:medios_cobro:tenant-uuid-test:_');
  });

  it('scopeByTenant=true sin tenant_id: NO suscribe (retorna null)', () => {
    const config = buildRealtimeConfig({
      table: 'medios_cobro',
      tenantId: null,
      localId: null,
      scopeByTenant: true,
      scopeByLocal: false,
    });
    expect(config).toBeNull();
  });

  it('scopeByTenant=false: NO incluye tenant_id en filtro', () => {
    const config = buildRealtimeConfig({
      table: 'kds_tokens',
      tenantId: 'tenant-uuid-test',
      localId: null,
      scopeByTenant: false,
      scopeByLocal: false,
    });
    expect(config).not.toBeNull();
    expect(config!.filter).toBeUndefined();
  });
});

describe('buildRealtimeConfig — filtro local', () => {
  it('scopeByLocal=true con local: incluye local_id', () => {
    const config = buildRealtimeConfig({
      table: 'mesas',
      tenantId: 'tenant-uuid',
      localId: 10,
      scopeByTenant: true,
      scopeByLocal: true,
    });
    expect(config!.filter).toContain('tenant_id=eq.tenant-uuid');
    expect(config!.filter).toContain('local_id=eq.10');
    expect(config!.channelName).toBe('rt:mesas:tenant-uuid:10');
  });

  it('scopeByLocal=true sin local: solo filtra por tenant', () => {
    const config = buildRealtimeConfig({
      table: 'mesas',
      tenantId: 'tenant-uuid',
      localId: null,
      scopeByTenant: true,
      scopeByLocal: true,
    });
    expect(config!.filter).toBe('tenant_id=eq.tenant-uuid');
  });

  it('scopeByLocal=false ignora local_id aunque esté presente', () => {
    const config = buildRealtimeConfig({
      table: 'medios_cobro',
      tenantId: 'tenant-uuid',
      localId: 10,
      scopeByTenant: true,
      scopeByLocal: false,
    });
    expect(config!.filter).toBe('tenant_id=eq.tenant-uuid');
    expect(config!.filter).not.toContain('local_id');
  });
});

describe('buildRealtimeConfig — extraFilter', () => {
  it('extraFilter se concatena con AND (& sintaxis PostgREST)', () => {
    const config = buildRealtimeConfig({
      table: 'ventas_pos',
      tenantId: 'tenant-uuid',
      localId: null,
      scopeByTenant: true,
      scopeByLocal: false,
      extraFilter: 'estado=eq.abierta',
    });
    expect(config!.filter).toBe('tenant_id=eq.tenant-uuid&estado=eq.abierta');
  });

  it('extraFilter solo (sin tenant ni local)', () => {
    const config = buildRealtimeConfig({
      table: 'kds_tokens',
      tenantId: null,
      localId: null,
      scopeByTenant: false,
      scopeByLocal: false,
      extraFilter: 'token=eq.abc123',
    });
    expect(config!.filter).toBe('token=eq.abc123');
  });

  it('extraFilter + tenant + local combinados', () => {
    const config = buildRealtimeConfig({
      table: 'movimientos_caja',
      tenantId: 'tenant-uuid',
      localId: 5,
      scopeByTenant: true,
      scopeByLocal: true,
      extraFilter: 'tipo=eq.venta',
    });
    expect(config!.filter).toBe('tenant_id=eq.tenant-uuid&local_id=eq.5&tipo=eq.venta');
  });
});

describe('buildRealtimeConfig — channelName', () => {
  it('canales únicos por (tabla, tenant, local) — diferentes scopes ≠ canales', () => {
    const a = buildRealtimeConfig({
      table: 'mesas', tenantId: 't1', localId: 1, scopeByTenant: true, scopeByLocal: true,
    });
    const b = buildRealtimeConfig({
      table: 'mesas', tenantId: 't1', localId: 2, scopeByTenant: true, scopeByLocal: true,
    });
    expect(a!.channelName).not.toBe(b!.channelName);
  });

  it('mismo (tabla, tenant, local) → mismo canal', () => {
    const a = buildRealtimeConfig({
      table: 'medios_cobro', tenantId: 't1', localId: null, scopeByTenant: true, scopeByLocal: false,
    });
    const b = buildRealtimeConfig({
      table: 'medios_cobro', tenantId: 't1', localId: null, scopeByTenant: true, scopeByLocal: false,
    });
    expect(a!.channelName).toBe(b!.channelName);
  });
});
