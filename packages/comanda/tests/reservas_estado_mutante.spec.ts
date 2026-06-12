import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDuenoClient } from './helpers/supabaseClient';

// MESA módulo #1 — mutante de la máquina de estados de reservas (09-jun).
// Actualizado 12-jun al modelo v3 (migración 202606130100): 'cumplida' ya no
// existe como estado — la RPC lo acepta como ALIAS de compat y lo interpreta
// como 'sentada' (bundles COMANDA viejos siguen andando).
//
// Cubre las 3 RPCs (migración 202606100400 + v3 202606130100):
//   fn_crear_reserva   — alta manual del staff (+ idempotency + validaciones)
//   fn_editar_reserva  — solo en pendiente/confirmada
//   fn_cambiar_estado_reserva — máquina ESTRICTA v3:
//       pendiente  → confirmada | sentada (walk-in) | cancelada
//       confirmada → sentada | no_show | cancelada
//       sentada    → finalizada
//       terminales (finalizada/no_show/cancelada) → RESERVA_TRANSICION_INVALIDA
//   + alias 'cumplida' → 'sentada' (compat)
//   + sentar con p_mesa_id opcional (valida mismo local).
//
// DB-only contra Local Prueba 2.

const LOCAL = 'Local Prueba 2';

test.describe('Reservas — máquina de estados (mutante)', () => {
  let db: SupabaseClient;
  let localId: number;
  const creadas: number[] = [];

  // Mañana a las 21:00 — siempre futura, no choca con check de fecha pasada.
  function fechaManana(): string {
    const d = new Date(Date.now() + 86400_000);
    d.setHours(21, 0, 0, 0);
    return d.toISOString();
  }

  async function crear(nombre: string, extra: Record<string, unknown> = {}): Promise<number> {
    const { data, error } = await db.rpc('fn_crear_reserva', {
      p_local_id: localId,
      p_cliente_nombre: nombre,
      p_fecha_hora: fechaManana(),
      p_personas: 2,
      ...extra,
    });
    if (error) throw new Error(`crear reserva: ${error.message}`);
    const id = Number(data);
    creadas.push(id);
    return id;
  }

  async function cambiar(id: number, estado: string, mesaId?: number) {
    return db.rpc('fn_cambiar_estado_reserva', {
      p_reserva_id: id, p_nuevo_estado: estado, p_motivo: null, p_mesa_id: mesaId ?? null,
    });
  }

  async function getEstado(id: number): Promise<{ estado: string; mesa_id: number | null }> {
    const { data } = await db.from('reservas').select('estado, mesa_id').eq('id', id).single();
    return data as { estado: string; mesa_id: number | null };
  }

  test.beforeEach(async () => {
    db = await createDuenoClient();
    const { data: locales } = await db.from('locales').select('id').eq('nombre', LOCAL);
    if (!locales || locales.length !== 1) throw new Error(`Local "${LOCAL}" no único`);
    localId = locales[0]!.id as number;
  });

  test.afterEach(async () => {
    for (const id of creadas.splice(0)) {
      const { error } = await db.from('reservas')
        .update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) console.error(`[cleanup] reserva ${id}:`, error.message);
    }
    try { await db.auth.signOut(); } catch { /* idempotente */ }
  });

  test('flujo feliz: crear → confirmar → sentar con mesa (alias cumplida → sentada)', async () => {
    const id = await crear('MUTANTE flujo feliz');
    expect((await getEstado(id)).estado).toBe('pendiente');

    const { error: e1 } = await cambiar(id, 'confirmada');
    expect(e1).toBeNull();
    expect((await getEstado(id)).estado).toBe('confirmada');

    // Sentar con mesa del MISMO local en el mismo paso. Se manda el alias
    // viejo 'cumplida' a propósito (compat bundles): v3 lo trata como 'sentada'.
    const { data: mesas } = await db.from('mesas')
      .select('id').eq('local_id', localId).is('deleted_at', null).limit(1);
    expect(mesas && mesas.length > 0).toBe(true);
    const mesaId = mesas![0]!.id as number;

    const { error: e2 } = await cambiar(id, 'cumplida', mesaId);
    expect(e2).toBeNull();
    const fin = await getEstado(id);
    expect(fin.estado, "alias 'cumplida' debe producir 'sentada' (modelo v3)").toBe('sentada');
    expect(fin.mesa_id).toBe(mesaId);
  });

  test('walk-in: pendiente → sentada directo está permitido (vía alias cumplida)', async () => {
    const id = await crear('MUTANTE walkin');
    const { error } = await cambiar(id, 'cumplida');
    expect(error).toBeNull();
    expect((await getEstado(id)).estado).toBe('sentada');

    // Y con el estado nuevo explícito también.
    const id2 = await crear('MUTANTE walkin v3');
    const { error: e2 } = await cambiar(id2, 'sentada');
    expect(e2).toBeNull();
    expect((await getEstado(id2)).estado).toBe('sentada');
  });

  test('transiciones inválidas → RESERVA_TRANSICION_INVALIDA', async () => {
    // no_show desde pendiente: prohibido (si nunca se confirmó, se cancela).
    const a = await crear('MUTANTE inv noshow');
    const { error: eA } = await cambiar(a, 'no_show');
    expect(eA).not.toBeNull();
    expect(eA!.message).toContain('RESERVA_TRANSICION_INVALIDA');
    expect((await getEstado(a)).estado).toBe('pendiente'); // no cambió

    // cancelada es TERMINAL: no se puede revivir a confirmada.
    const b = await crear('MUTANTE inv revivir');
    await cambiar(b, 'cancelada');
    const { error: eB } = await cambiar(b, 'confirmada');
    expect(eB).not.toBeNull();
    expect(eB!.message).toContain('RESERVA_TRANSICION_INVALIDA');
    expect((await getEstado(b)).estado).toBe('cancelada');

    // sentada NO es terminal pero SOLO va a finalizada (v3): cancelar falla.
    const c = await crear('MUTANTE inv sentada');
    await cambiar(c, 'cumplida'); // alias → sentada
    const { error: eC } = await cambiar(c, 'cancelada');
    expect(eC).not.toBeNull();
    expect(eC!.message).toContain('RESERVA_TRANSICION_INVALIDA');

    // sentada → finalizada es la única salida válida.
    const { error: eFin } = await cambiar(c, 'finalizada');
    expect(eFin).toBeNull();
    expect((await getEstado(c)).estado).toBe('finalizada');

    // finalizada es el TERMINAL nuevo: ninguna transición posterior.
    const { error: eTerm } = await cambiar(c, 'sentada');
    expect(eTerm).not.toBeNull();
    expect(eTerm!.message).toContain('RESERVA_TRANSICION_INVALIDA');
  });

  test('mesa de OTRO local al sentar → MESA_OTRO_LOCAL', async () => {
    const id = await crear('MUTANTE mesa ajena');
    const { data: ajena } = await db.from('mesas')
      .select('id').neq('local_id', localId).is('deleted_at', null).limit(1);
    test.skip(!ajena?.length, 'No hay mesas de otro local');
    const { error } = await cambiar(id, 'cumplida', ajena![0]!.id as number);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('MESA_OTRO_LOCAL');
    expect((await getEstado(id)).estado).toBe('pendiente');
  });

  test('editar: permitido en pendiente, rechazado en terminal', async () => {
    const id = await crear('MUTANTE editar');
    const { error: e1 } = await db.rpc('fn_editar_reserva', {
      p_reserva_id: id, p_cliente_nombre: 'MUTANTE editado', p_personas: 6,
    });
    expect(e1).toBeNull();
    const { data: r1 } = await db.from('reservas').select('cliente_nombre, personas').eq('id', id).single();
    expect(r1!.cliente_nombre).toBe('MUTANTE editado');
    expect(Number(r1!.personas)).toBe(6);

    await cambiar(id, 'cancelada');
    const { error: e2 } = await db.rpc('fn_editar_reserva', {
      p_reserva_id: id, p_personas: 4,
    });
    expect(e2).not.toBeNull();
    expect(e2!.message).toContain('RESERVA_NO_EDITABLE');
  });

  test('crear: idempotency + validaciones', async () => {
    const key = `mutante-reservas-${Date.now()}`;
    const id1 = await crear('MUTANTE idem', { p_idempotency_key: key });
    // Mismo key → devuelve el MISMO id, no crea otra.
    const { data: id2, error } = await db.rpc('fn_crear_reserva', {
      p_local_id: localId, p_cliente_nombre: 'MUTANTE idem',
      p_fecha_hora: fechaManana(), p_personas: 2, p_idempotency_key: key,
    });
    expect(error).toBeNull();
    expect(Number(id2)).toBe(id1);

    // Validaciones.
    const { error: eNombre } = await db.rpc('fn_crear_reserva', {
      p_local_id: localId, p_cliente_nombre: '  ', p_fecha_hora: fechaManana(), p_personas: 2,
    });
    expect(eNombre!.message).toContain('NOMBRE_REQUERIDO');

    const { error: ePers } = await db.rpc('fn_crear_reserva', {
      p_local_id: localId, p_cliente_nombre: 'X', p_fecha_hora: fechaManana(), p_personas: 99,
    });
    expect(ePers!.message).toContain('PERSONAS_INVALIDAS');

    const { error: eFecha } = await db.rpc('fn_crear_reserva', {
      p_local_id: localId, p_cliente_nombre: 'X',
      p_fecha_hora: new Date(Date.now() - 3 * 3600_000).toISOString(), p_personas: 2,
    });
    expect(eFecha!.message).toContain('FECHA_PASADA');
  });
});
