// Simulación de webhook MP en tests E2E.
//
// En producción, MP manda POST a /api/tienda-mp?action=webhook con un body
// firmado HMAC (header `x-signature`). Para tests, simulamos el body y
// firmamos con el MP_WEBHOOK_SECRET configurado en Vercel.
//
// Si el secret no está en env, se loguea warning y el webhook se manda
// sin firma (el endpoint igual lo procesa pero queda flag `hmac_mismatch`).

import crypto from "node:crypto";

export interface SimulatedMpWebhookOptions {
  baseUrl: string; // ej "http://localhost:5173"
  paymentId: string | number;
  type?: "payment" | "merchant_order";
  webhookSecret?: string;
  source?: number;
}

/**
 * POST simulado al endpoint /api/tienda-mp?action=webhook con un payload
 * tipo `payment.updated`. El endpoint busca el payment_id en MP API real
 * via el access token configurado — en tests E2E asumimos que el payment_id
 * existe en la app de prueba MP o el endpoint loggea error sin romper.
 *
 * Si querés un test que NO dependa del API MP real, usa
 * `simulateMpPaymentApproved` que actúa directo sobre `mp_movimientos` y
 * `ventas_pos` saltando el call externo.
 */
export async function simulateMpWebhookCall(opts: SimulatedMpWebhookOptions): Promise<Response> {
  const body = {
    action: "payment.updated",
    data: { id: String(opts.paymentId) },
    type: opts.type ?? "payment",
  };
  const bodyStr = JSON.stringify(body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // HMAC opcional. Formato según MP: ts=<timestamp>,v1=<sha256>
  if (opts.webhookSecret) {
    const ts = Date.now();
    const requestId = crypto.randomUUID();
    const dataId = String(opts.paymentId);
    // MP firma: "id:<dataId>;request-id:<requestId>;ts:<ts>;"
    const signedString = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const sig = crypto.createHmac("sha256", opts.webhookSecret).update(signedString).digest("hex");
    headers["x-signature"] = `ts=${ts},v1=${sig}`;
    headers["x-request-id"] = requestId;
  }

  const sourceQ = opts.source ? `&source=${opts.source}` : "";
  return fetch(`${opts.baseUrl}/api/tienda-mp?action=webhook${sourceQ}`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
}

/**
 * Inyección directa en `mp_movimientos`: simula que MP confirmó un pago sin
 * pegar al API externo. Usar cuando el test sólo necesita el efecto en DB,
 * no el round-trip completo.
 *
 * Devuelve el `mp_movimientos.id` insertado.
 */
export async function simulateMpPaymentApproved(opts: {
  serviceClient: import("@supabase/supabase-js").SupabaseClient;
  tenantId: string;
  localId: number;
  paymentId: string;
  monto: number;
  descripcion: string;
  fecha?: Date;
}): Promise<string> {
  const fecha = opts.fecha ?? new Date();
  const { error } = await opts.serviceClient.from("mp_movimientos").insert({
    id: opts.paymentId,
    tenant_id: opts.tenantId,
    local_id: opts.localId,
    monto: opts.monto,
    descripcion: opts.descripcion,
    fecha,
    estado: "approved",
    origen: "test_e2e",
  });
  if (error) throw new Error(`simulateMpPaymentApproved insert falló: ${error.message}`);
  return opts.paymentId;
}
