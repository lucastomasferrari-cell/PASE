// Service para gestionar ventas online con AFIP pendiente.
//
// Las ventas se marcan automáticamente con `afip_pendiente=true` cuando el
// webhook MP de la tienda online (server-side, tienda-mp.js) cobra OK pero
// la emisión post-cobro de AFIP falla. Queda registrado:
//   - ventas_pos.afip_pendiente = true
//   - ventas_pos.afip_ultimo_error = mensaje del rechazo
//   - ventas_pos.afip_ultimo_intento_at = timestamp
//
// La UI (AfipPendientes.tsx) las muestra y permite reintentar manualmente.
// El reintento usa el mismo endpoint /api/afip-cae que las facturas normales,
// armando el request a partir de la venta + credenciales AFIP del tenant.

import { db } from '../supabase';
import { emitirFactura } from './client';
import { getCredencialesAFIP } from './service';
import type { AfipFacturaResult, AfipTipoComprobante } from './types';

export interface VentaAfipPendiente {
  id: number;
  local_id: number;
  total: number;
  subtotal: number | null;
  cliente_nombre: string | null;
  cliente_email: string | null;
  cliente_telefono: string | null;
  afip_ultimo_error: string | null;
  afip_ultimo_intento_at: string | null;
  created_at: string;
}

/**
 * Lista las ventas con AFIP pendiente del local activo (o de todos los locales
 * visibles si no se pasa `localId`).
 */
export async function listarVentasAfipPendientes(localId?: number | null): Promise<{
  data: VentaAfipPendiente[];
  error: string | null;
}> {
  let q = db
    .from('ventas_pos')
    .select('id, local_id, total, subtotal, cliente_nombre, cliente_email, cliente_telefono, afip_ultimo_error, afip_ultimo_intento_at, created_at')
    .eq('afip_pendiente', true)
    .order('afip_ultimo_intento_at', { ascending: false, nullsFirst: false });
  if (localId) q = q.eq('local_id', localId);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaAfipPendiente[], error: null };
}

/**
 * Reintenta emitir el CAE para una venta con afip_pendiente=true.
 *
 * Calcula tipo_comprobante e iva según el `tipo_contribuyente` configurado:
 *   - monotributo / exento  → Factura C (11), IVA 0
 *   - responsable_inscripto → Factura B (6), IVA 21% (consumidor final)
 *
 * Si emite OK, el flag `afip_pendiente` se limpia automáticamente (lo hace
 * el server al insertar afip_facturas exitosamente — confirmar). Acá hacemos
 * el UPDATE explícito como safety net por si el server no lo hace.
 *
 * Usa `request_uuid` único por intento (`retry-{ventaId}-{timestamp}`) para
 * no chocar con la idempotency del fallido anterior.
 */
export async function reintentarAfipVenta(ventaId: number): Promise<{
  ok: boolean;
  result?: AfipFacturaResult;
  error?: string;
}> {
  // 1. Levantar venta (incluyendo el afip_request_uuid original — fix
  //    code-review 27-jun: reusarlo para que AFIP devuelva el CAE cacheado
  //    si ya emitió, en lugar de emitir un comprobante con número nuevo).
  const { data: venta, error: errVenta } = await db
    .from('ventas_pos')
    .select('id, total, cliente_email, cliente_nombre, afip_request_uuid')
    .eq('id', ventaId)
    .maybeSingle();
  if (errVenta || !venta) return { ok: false, error: 'Venta no encontrada' };

  // 2. Levantar credenciales AFIP del tenant
  const { data: cred, error: errCred } = await getCredencialesAFIP();
  if (errCred || !cred) return { ok: false, error: 'AFIP no configurada' };
  if (!cred.activa) return { ok: false, error: 'AFIP no está activa' };

  // 3. Calcular tipo de comprobante + neto/iva
  const total = Number(venta.total);
  let cbteTipo: AfipTipoComprobante;
  let importeNeto: number;
  let importeIva: number;
  if (cred.tipo_contribuyente === 'responsable_inscripto') {
    cbteTipo = 6; // Factura B
    importeNeto = Number((total / 1.21).toFixed(2));
    importeIva = Number((total - importeNeto).toFixed(2));
  } else {
    // monotributo / exento → Factura C, IVA 0
    cbteTipo = 11;
    importeNeto = total;
    importeIva = 0;
  }

  // 4. Llamar al endpoint con request_uuid persistido (fix code-review 27-jun).
  //    Si la venta nunca pasó por el flow online (no tiene afip_request_uuid),
  //    generamos uno nuevo Y lo persistimos para que futuros retries lo reusen.
  let requestUuid = (venta as { afip_request_uuid?: string | null }).afip_request_uuid ?? null;
  if (!requestUuid) {
    requestUuid = `retry-${ventaId}-${Date.now()}`;
    try {
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- afip_request_uuid es metadata de idempotency fiscal no-monetaria.
      await db
        .from('ventas_pos')
        .update({ afip_request_uuid: requestUuid })
        .eq('id', ventaId)
        .is('afip_request_uuid', null);
    } catch {
      /* no crítico: si falla guardar, igual usamos el uuid generado ahora */
    }
  }
  try {
    const result = await emitirFactura({
      tenant_id: cred.tenant_id ?? '', // server lo resuelve del JWT
      venta_pos_id: ventaId,
      tipo_comprobante: cbteTipo,
      importe_neto: importeNeto,
      importe_iva: importeIva,
      importe_total: total,
      concepto: 1,
      doc_tipo: 99, // consumidor final
      doc_nro: '0',
      cliente_razon_social: venta.cliente_nombre ?? null,
      request_uuid: requestUuid,
    });

    // 5. Limpiar el flag (safety net — el server al insertar afip_facturas
    //    también debería limpiarlo, pero garantizamos consistencia desde acá).
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- afip_pendiente/afip_ultimo_error son flags fiscales no-monetarios. No tocamos total ni items.
    await db
      .from('ventas_pos')
      .update({ afip_pendiente: false, afip_ultimo_error: null })
      .eq('id', ventaId);

    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Actualizar afip_ultimo_intento_at + error
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- afip_ultimo_intento_at/afip_ultimo_error son metadata fiscal no-monetaria. No tocamos total ni items.
    await db
      .from('ventas_pos')
      .update({
        afip_ultimo_intento_at: new Date().toISOString(),
        afip_ultimo_error: msg,
      })
      .eq('id', ventaId);
    return { ok: false, error: msg };
  }
}
