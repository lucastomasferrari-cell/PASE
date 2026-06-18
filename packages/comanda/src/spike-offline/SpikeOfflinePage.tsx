// SPIKE OFFLINE (descartable, solo dev) — sandbox para validar el motor
// local-first (RxDB). NO es producción. Corre el flujo abrir→agregar→cobrar
// contra el store LOCAL (instantáneo) y sincroniza con Supabase en background.
//
// Cómo validar los 6 criterios (ver checklist abajo):
//  - Instantáneo: tocar "Agregar ítem" → la lista actualiza sin esperar.
//  - Offline real: DevTools → Network → Offline → correr el flujo completo.
//  - Sobrevive recarga: con la red OFF, F5 → el estado sigue.
//  - Reconcilia: red ON → ver en Supabase que las filas suben (una sola vez).
//  - RLS: solo trae/sube filas de tu tenant/local.
import { useEffect, useRef, useState } from 'react';
import { db as supa } from '../lib/supabase';
import { crearSpikeDB, type SpikeDB } from './db';
import { startReplication } from './replication';
import { abrirMesa, agregarItem, cobrar, type Ctx } from './flow';
import type { VentaDoc, ItemDoc, PagoDoc } from './schema';

const PRECIOS = [3500, 5000, 7000, 9500];

export function SpikeOfflinePage() {
  const [db, setDb] = useState<SpikeDB | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [localId, setLocalId] = useState(2);
  const [ventaUuid, setVentaUuid] = useState<string | null>(null);
  const [ventas, setVentas] = useState<VentaDoc[]>([]);
  const [items, setItems] = useState<ItemDoc[]>([]);
  const [pagos, setPagos] = useState<PagoDoc[]>([]);
  const [syncOn, setSyncOn] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const stopRepl = useRef<(() => void) | null>(null);
  const addLog = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 30));

  // Crear la DB local al montar + best-effort traer tenant_id de la sesión.
  useEffect(() => {
    let cancel = false;
    (async () => {
      const database = await crearSpikeDB();
      if (cancel) { await database.remove(); return; }
      setDb(database);
      addLog('store local listo (RxDB/Dexie)');
      try {
        const { data: u } = await supa.auth.getUser();
        if (u?.user) {
          const { data } = await supa.from('comanda_usuarios').select('tenant_id, locales').eq('auth_id', u.user.id).maybeSingle();
          if (data?.tenant_id) { setTenantId(data.tenant_id as string); addLog('tenant_id de la sesión: ' + data.tenant_id); }
        }
      } catch { addLog('no pude auto-traer tenant_id — cargalo a mano'); }
    })();
    return () => { cancel = true; stopRepl.current?.(); };
  }, []);

  // Suscripción reactiva: la pantalla se dibuja del store local EN VIVO.
  useEffect(() => {
    if (!db) return;
    const subs = [
      db.ventas.find().$.subscribe((d) => setVentas(d.map((x) => x.toJSON() as VentaDoc))),
      db.items.find().$.subscribe((d) => setItems(d.map((x) => x.toJSON() as ItemDoc))),
      db.pagos.find().$.subscribe((d) => setPagos(d.map((x) => x.toJSON() as PagoDoc))),
    ];
    return () => subs.forEach((s) => s.unsubscribe());
  }, [db]);

  const ctx: Ctx = { tenant_id: tenantId, local_id: localId };
  const ventaActual = ventas.find((v) => v.idempotency_uuid === ventaUuid);
  const itemsActual = items.filter((i) => i.venta_idempotency_uuid === ventaUuid);
  const pagosActual = pagos.filter((p) => p.venta_idempotency_uuid === ventaUuid);

  function toggleSync() {
    if (!db) return;
    if (syncOn) { stopRepl.current?.(); stopRepl.current = null; setSyncOn(false); addLog('sync OFF'); }
    else { stopRepl.current = startReplication(db); setSyncOn(true); addLog('sync ON (background)'); }
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui', maxWidth: 860 }}>
      <h1>Spike Offline — sandbox <span style={{ fontSize: 13, color: '#888' }}>(descartable, no es producción)</span></h1>

      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap', margin: '12px 0' }}>
        <label>tenant_id<br /><input value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ width: 320 }} placeholder="uuid del tenant (para que suba bien)" /></label>
        <label>local_id<br /><input type="number" value={localId} onChange={(e) => setLocalId(Number(e.target.value))} style={{ width: 80 }} /></label>
        <button onClick={toggleSync} disabled={!db} style={{ padding: '6px 12px' }}>{syncOn ? '⏸ Sync OFF' : '▶ Sync ON'}</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        <button disabled={!db} onClick={async () => { const u = await abrirMesa(db!, ctx, 1); setVentaUuid(u); addLog('abrir mesa → ' + u.slice(0, 8)); }}>Abrir mesa</button>
        <button disabled={!db || !ventaUuid} onClick={async () => { await agregarItem(db!, ctx, ventaUuid!, { item_id: 1, precio_unitario: PRECIOS[Math.floor(Math.random() * PRECIOS.length)]!, curso: 1 }); addLog('agregar ítem'); }}>+ Agregar ítem</button>
        <button disabled={!db || !ventaUuid} onClick={async () => { await cobrar(db!, ctx, ventaUuid!, 'efectivo', ventaActual?.total ?? 0); addLog('cobrar'); }}>Cobrar</button>
      </div>

      <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
        <b>Venta actual</b> {ventaActual ? `· ${ventaActual.estado} · total $${ventaActual.total}` : '— (tocá Abrir mesa)'}
        <div>Ítems: {itemsActual.length} · Pagos: {pagosActual.length}</div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>id server: {ventaActual?.id ?? '(null, aún no sincronizada)'}</div>
      </div>

      <div style={{ marginTop: 16 }}>
        <b>Criterios a validar:</b>
        <ol style={{ fontSize: 13, color: '#444' }}>
          <li>Instantáneo: "Agregar ítem" repetido actualiza sin lag (DevTools Performance: repaint &lt;100ms, sin request en el toque).</li>
          <li>Offline real: DevTools→Network→Offline → abrir→agregar→cobrar funciona.</li>
          <li>Sobrevive recarga: con red OFF, F5 → sigue el estado.</li>
          <li>Reconcilia: Sync ON con red → en Supabase aparecen las filas una sola vez (id server se llena).</li>
          <li>RLS: solo sube/trae filas de tu tenant/local (probar tenant ajeno → rechaza).</li>
        </ol>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, fontFamily: 'monospace', color: '#555', maxHeight: 200, overflow: 'auto' }}>
        {log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
