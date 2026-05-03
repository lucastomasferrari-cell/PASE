import { describe, it, expect, vi } from 'vitest';
import {
  fetchPaymentsByDateCreated,
  mapPaymentToRows,
  formatArIso,
} from './_mp-payments-search.js';

// ─── Helpers de mocking ──────────────────────────────────────────────────────

function makeResponse({ status = 200, body = { results: [], paging: { total: 0 } }, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => headers[k.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// Crea una secuencia de fetch que devuelve responses en orden, en cada call.
function makeFetchSeq(responses) {
  let i = 0;
  return vi.fn(async (_url) => {
    if (i >= responses.length) throw new Error('fetchSeq agotado');
    return responses[i++];
  });
}

// ─── fetchPaymentsByDateCreated ──────────────────────────────────────────────

describe('fetchPaymentsByDateCreated — paginación', () => {
  it('una sola página < limit, devuelve todo', async () => {
    const fetchFn = makeFetchSeq([
      makeResponse({
        body: { paging: { total: 3 }, results: [{ id: 1 }, { id: 2 }, { id: 3 }] },
        headers: { 'x-request-id': 'req-A' },
      }),
    ]);
    const r = await fetchPaymentsByDateCreated('TKN', '2026-05-01', '2026-05-02', { fetchFn });
    expect(r.payments).toHaveLength(3);
    expect(r.pages).toBe(1);
    expect(r.pagingTotal).toBe(3);
    expect(r.firstRequestId).toBe('req-A');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('paginación múltiple: 100 + 100 + 47 = 247 results en 3 páginas', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ id: i + 101 }));
    const page3 = Array.from({ length: 47 }, (_, i) => ({ id: i + 201 }));
    const fetchFn = makeFetchSeq([
      makeResponse({ body: { paging: { total: 247 }, results: page1 } }),
      makeResponse({ body: { paging: { total: 247 }, results: page2 } }),
      makeResponse({ body: { paging: { total: 247 }, results: page3 } }),
    ]);
    const r = await fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn });
    expect(r.payments).toHaveLength(247);
    expect(r.pages).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('respeta maxPages como cap defensivo', async () => {
    // Cada página devuelve exactamente limit → loop infinito sin cap.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const fetchFn = vi.fn(async () => makeResponse({ body: { paging: { total: 10000 }, results: fullPage } }));
    const r = await fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, maxPages: 3 });
    expect(r.pages).toBe(3);
    expect(r.payments).toHaveLength(300);
  });
});

describe('fetchPaymentsByDateCreated — lotería', () => {
  it('sin lotería (threshold=0): una sola pasada aunque devuelva pocos', async () => {
    const fetchFn = makeFetchSeq([
      makeResponse({ body: { paging: { total: 5 }, results: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] } }),
    ]);
    const r = await fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, threshold: 0 });
    expect(r.lotteryAttempts).toBe(1);
    expect(r.payments).toHaveLength(5);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('con lotería (threshold=20): reintenta hasta superar threshold', async () => {
    const small = Array.from({ length: 11 }, (_, i) => ({ id: i }));
    const big = Array.from({ length: 20 }, (_, i) => ({ id: i + 100 }));
    const fetchFn = makeFetchSeq([
      makeResponse({ body: { paging: { total: 11 }, results: small } }), // intento 1: bajo
      makeResponse({ body: { paging: { total: 11 }, results: small } }), // intento 2: bajo
      makeResponse({ body: { paging: { total: 20 }, results: big } }),   // intento 3: alcanza
    ]);
    const r = await fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, threshold: 20, lotteryMaxAttempts: 5 });
    expect(r.lotteryAttempts).toBe(3);
    expect(r.payments).toHaveLength(20);
  });

  it('lotería se rinde tras lotteryMaxAttempts y devuelve la mejor pasada', async () => {
    const small = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const medium = Array.from({ length: 11 }, (_, i) => ({ id: i + 10 }));
    const fetchFn = makeFetchSeq([
      makeResponse({ body: { paging: { total: 5 }, results: small } }),
      makeResponse({ body: { paging: { total: 11 }, results: medium } }), // mejor
      makeResponse({ body: { paging: { total: 5 }, results: small } }),
    ]);
    const r = await fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, threshold: 20, lotteryMaxAttempts: 3 });
    expect(r.lotteryAttempts).toBe(3);
    expect(r.payments).toHaveLength(11); // la mejor de las 3
  });
});

describe('fetchPaymentsByDateCreated — reintentos en 429/5xx', () => {
  it('429 → backoff y reintenta hasta éxito', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = makeFetchSeq([
        makeResponse({ status: 429 }),
        makeResponse({ status: 503 }),
        makeResponse({ body: { paging: { total: 1 }, results: [{ id: 1 }] } }),
      ]);
      const promise = fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, fetchRetries: 3 });
      await vi.runAllTimersAsync();
      const r = await promise;
      expect(r.payments).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agota reintentos en 429/5xx → propaga error', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = makeFetchSeq([
        makeResponse({ status: 502 }),
        makeResponse({ status: 502 }),
        makeResponse({ status: 502 }),
        makeResponse({ status: 502 }),
      ]);
      const promise = fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, fetchRetries: 3, lotteryMaxAttempts: 1 });
      // Attach assertion ANTES de runAllTimersAsync para que Node vea el handler
      // y no tire PromiseRejectionHandledWarning.
      const assertion = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('4xx no-retryable propaga inmediato (401, 403)', async () => {
    const fetchFn = makeFetchSeq([
      makeResponse({ status: 401, body: { message: 'invalid token' } }),
    ]);
    await expect(
      fetchPaymentsByDateCreated('TKN', 'b', 'e', { fetchFn, fetchRetries: 3, lotteryMaxAttempts: 1 })
    ).rejects.toThrow(/401/);
  });
});

// ─── mapPaymentToRows ────────────────────────────────────────────────────────

const CRED = { local_id: 1, tenant_id: 'tenant-uuid' };
const OUR_ACCOUNT = 73828709;

describe('mapPaymentToRows', () => {
  it('payment con status=charged_back → row emitido con anulado=true', () => {
    // Antes hacíamos skip total si status != approved. Ahora emitimos la fila
    // con anulado=true para reflejar la transición y que el daily job o el
    // conciliador la oculten correctamente.
    const rows = mapPaymentToRows({
      id: 999, status: 'charged_back',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT, payer: { id: 1 },
      transaction_amount: 1000, transaction_details: { net_received_amount: 950 },
      payment_method_id: 'visa', point_of_interaction: { type: 'POINT' },
      money_release_date: '2026-05-11T00:00:00-04:00',
      money_release_status: 'pending',
    }, CRED, OUR_ACCOUNT);
    // Main row + fee fallback
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const main = rows[0].row;
    expect(main.id).toBe('pay-999');
    expect(main.mp_status).toBe('charged_back');
    expect(main.anulado).toBe(true);
    expect(main.anulado_motivo).toBe('mp_status_charged_back');
    expect(main.anulado_at).toBeTruthy();
  });

  it('payment con status=cancelled → anulado=true, anulado_motivo=mp_status_cancelled', () => {
    const rows = mapPaymentToRows({
      id: 1, status: 'cancelled',
      collector_id: OUR_ACCOUNT, payer: { id: 99 },
      transaction_amount: 500, transaction_details: { net_received_amount: 470 },
      payment_method_id: 'visa', point_of_interaction: { type: 'POINT' },
    }, CRED, OUR_ACCOUNT);
    expect(rows[0].row.anulado).toBe(true);
    expect(rows[0].row.anulado_motivo).toBe('mp_status_cancelled');
  });

  it('payment approved → anulado=false explícito (NOT NULL), sin anulado_motivo', () => {
    // anulado es NOT NULL en schema. Antes lo dejábamos undefined cuando
    // approved y supabase-js lo serializaba como null → batch upsert fallaba
    // con not-null constraint violation. Ahora false explícito.
    const rows = mapPaymentToRows({
      id: 1, status: 'approved',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT, payer: { id: 99 },
      transaction_amount: 1000, transaction_details: { net_received_amount: 950 },
      payment_method_id: 'visa', point_of_interaction: { type: 'POINT' },
    }, CRED, OUR_ACCOUNT);
    expect(rows[0].row.anulado).toBe(false);
    expect(rows[0].row.anulado_motivo).toBeUndefined();
    expect(rows[0].row.anulado_at).toBeUndefined();
    expect(rows[0].row.mp_status).toBe('approved');
  });

  it('fee/tax de payment approved → anulado=false explícito heredado', () => {
    // Mismo motivo: NOT NULL en schema. Las fee-/tax-* del batch caían junto
    // con la pay-* main si alguna fila salía con anulado=null implícito.
    const rows = mapPaymentToRows({
      id: 12345,
      status: 'approved',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT, payer: { id: 99 },
      transaction_amount: 1000, transaction_details: { net_received_amount: 920 },
      payment_method_id: 'visa', point_of_interaction: { type: 'POINT' },
      money_release_date: '2026-05-11T00:00:00-04:00',
      money_release_status: 'pending',
      charges_details: [
        { id: '12345-001', name: 'mercadopago_fee', type: 'fee',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 50, refunded: 0 } },
        { id: '12345-002', name: 'tax_withholding-caba', type: 'tax',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 30, refunded: 0 },
          metadata: { mov_detail: 'tax_withholding', mov_financial_entity: 'caba',
                      source_detail: 'iibb_caba_charge' } },
      ],
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(3);
    expect(rows[0].row.anulado).toBe(false);
    expect(rows[1].row.anulado).toBe(false);  // fee
    expect(rows[2].row.anulado).toBe(false);  // tax
  });

  it('fee legacy fallback de payment approved → anulado=false explícito', () => {
    // Sin charges_details pero con commission detectable por diff bruto-neto.
    const rows = mapPaymentToRows({
      id: 99999,
      status: 'approved',
      date_created: '2025-01-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT, payer: { id: 88 },
      transaction_amount: 1000, transaction_details: { net_received_amount: 940 },
      payment_method_id: 'visa', point_of_interaction: { type: 'POINT' },
    }, CRED, OUR_ACCOUNT);
    // main + fee legacy
    expect(rows.length).toBe(2);
    expect(rows[0].row.anulado).toBe(false);
    expect(rows[1].row.id).toBe('fee-99999-legacy');
    expect(rows[1].row.anulado).toBe(false);
  });

  it('skip si transferencia interna (collector == payer == ours)', () => {
    const rows = mapPaymentToRows({
      id: 1, status: 'approved',
      collector_id: OUR_ACCOUNT, payer: { id: OUR_ACCOUNT },
      transaction_amount: 4000, transaction_details: { net_received_amount: 4000 },
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].skipped).toBe(true);
    expect(rows[0].reason).toBe('internal_transfer');
  });

  it('ingreso POINT con charges_details + release fields → main + fee + tax (3 filas)', () => {
    const rows = mapPaymentToRows({
      id: 157334804646,
      status: 'approved',
      date_created: '2026-05-01T22:26:00.000-04:00',
      collector_id: OUR_ACCOUNT,
      payer: { id: 12345 },
      transaction_amount: 168500,
      transaction_details: { net_received_amount: 155340.15 },
      payment_method_id: 'visa',
      payment_type_id: 'credit_card',
      point_of_interaction: { type: 'POINT' },
      // TASK 0.18 final — release fields persistidos en main + heredados en fee/tax
      money_release_date: '2026-05-11T22:26:22.000-04:00',
      money_release_status: 'pending',
      // Caso real del 1/5/2026, dump del endpoint inspect
      charges_details: [
        {
          id: '157334804646-001',
          name: 'mercadopago_fee',
          type: 'fee',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 8947.35, refunded: 0 },
          metadata: { source_detail: 'processing_fee_charge' },
        },
        {
          id: '157334804646-002',
          name: 'tax_withholding-caba',
          type: 'tax',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 4212.5, refunded: 0 },
          metadata: { mov_detail: 'tax_withholding', mov_financial_entity: 'caba',
                      source_detail: 'iibb_caba_charge' },
        },
      ],
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(3);
    // Main: persiste release fields + monto_bruto + mp_status
    expect(rows[0].row).toMatchObject({
      id: 'pay-157334804646',
      tipo: 'liquidacion',
      monto: 155340.15,                      // neto
      monto_bruto: 168500,                    // bruto = transaction_amount
      mp_status: 'approved',
      money_release_status: 'pending',
      money_release_date: '2026-05-11T22:26:22.000-04:00',
      medio_pago: 'point_smart_visa',
    });
    // Fee comisión MP — hereda money_release_*, NO tiene monto_bruto ni mp_status
    expect(rows[1].row).toMatchObject({
      id: 'fee-157334804646-001',
      tipo: 'fee',
      monto: -8947.35,
      descripcion: 'Comisión MP',
      referencia_id: '157334804646',
      medio_pago: 'point_smart_visa',
      money_release_status: 'pending',
      money_release_date: '2026-05-11T22:26:22.000-04:00',
    });
    expect(rows[1].row.monto_bruto).toBeUndefined();
    expect(rows[1].row.mp_status).toBeUndefined();
    // Tax IIBB CABA — hereda money_release_*
    expect(rows[2].row).toMatchObject({
      id: 'tax-157334804646-002',
      tipo: 'tax',
      monto: -4212.5,
      descripcion: 'Retención IIBB CABA',
      referencia_id: '157334804646',
      medio_pago: 'point_smart_visa',
      money_release_status: 'pending',
      money_release_date: '2026-05-11T22:26:22.000-04:00',
    });
    expect(rows[2].row.monto_bruto).toBeUndefined();
    expect(rows[2].row.mp_status).toBeUndefined();
  });

  it('ingreso CHECKOUT con application_id null → INCLUYE fee de application_owner', () => {
    // Caso real 156528808241: 3 charges. application_id null = Lucas usa
    // MP Checkout estándar = application_owner === Lucas → su mercadopago_fee
    // de app_owner cuenta. third_payment (collector) + mercadopago_fee
    // (app_owner) + tax_withholding-caba (collector).
    const rows = mapPaymentToRows({
      id: 156528808241,
      status: 'approved',
      date_created: '2026-05-01T16:54:00.000-04:00',
      collector_id: OUR_ACCOUNT,
      payer: { id: 222708650 },
      transaction_amount: 105950,
      transaction_details: { net_received_amount: 94337.88 },
      payment_method_id: 'visa',
      point_of_interaction: { type: 'CHECKOUT' },
      description: 'Pedido en Neko Sushi',
      application_id: null,
      charges_details: [
        {
          id: '156528808241-001',
          name: 'third_payment',
          type: 'fee',
          accounts: { from: 'collector', to: 'marketplace_owner' },
          amounts: { original: 8963.37, refunded: 0 },
        },
        {
          id: '156528808241-002',
          name: 'mercadopago_fee',
          type: 'fee',
          accounts: { from: 'application_owner', to: 'mp' },
          amounts: { original: 8338.27, refunded: 0 },
        },
        {
          id: '156528808241-003',
          name: 'tax_withholding-caba',
          type: 'tax',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 2648.75, refunded: 0 },
          metadata: { mov_detail: 'tax_withholding', mov_financial_entity: 'caba',
                      source_detail: 'iibb_caba_charge' },
        },
      ],
    }, CRED, OUR_ACCOUNT);
    // 1 main + 2 fees (third_payment collector + mercadopago_fee app_owner) + 1 tax.
    expect(rows).toHaveLength(4);
    expect(rows[0].row.tipo).toBe('liquidacion');
    expect(rows[1].row).toMatchObject({
      id: 'fee-156528808241-001',
      tipo: 'fee',
      monto: -8963.37,
      descripcion: 'Comisión MP (Checkout)',
    });
    expect(rows[2].row).toMatchObject({
      id: 'fee-156528808241-002',
      tipo: 'fee',
      monto: -8338.27,
      descripcion: 'Comisión MP',
    });
    expect(rows[3].row).toMatchObject({
      id: 'tax-156528808241-003',
      tipo: 'tax',
      monto: -2648.75,
      descripcion: 'Retención IIBB CABA',
    });
  });

  it('ingreso CHECKOUT con application_id de TERCERO → excluye fee de application_owner', () => {
    // Si la integración usa una app de tercero (application_id != null),
    // application_owner NO es el merchant. El mercadopago_fee desde
    // app_owner lo paga el dueño de la app (no el merchant). NO sumar.
    const rows = mapPaymentToRows({
      id: 156528808241,
      status: 'approved',
      date_created: '2026-05-01T16:54:00.000-04:00',
      collector_id: OUR_ACCOUNT,
      payer: { id: 222708650 },
      transaction_amount: 105950,
      transaction_details: { net_received_amount: 94337.88 },
      payment_method_id: 'visa',
      point_of_interaction: { type: 'CHECKOUT' },
      application_id: 'app-de-tercero-12345',  // ← KEY: app de un tercero
      charges_details: [
        {
          id: '156528808241-001',
          name: 'third_payment',
          type: 'fee',
          accounts: { from: 'collector', to: 'marketplace_owner' },
          amounts: { original: 8963.37, refunded: 0 },
        },
        {
          id: '156528808241-002',
          name: 'mercadopago_fee',
          type: 'fee',
          accounts: { from: 'application_owner', to: 'mp' },
          amounts: { original: 8338.27, refunded: 0 },
        },
        {
          id: '156528808241-003',
          name: 'tax_withholding-caba',
          type: 'tax',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 2648.75 },
        },
      ],
    }, CRED, OUR_ACCOUNT);
    // 1 main + 1 fee (third_payment) + 1 tax. mercadopago_fee app_owner ignorado.
    expect(rows).toHaveLength(3);
    expect(rows.some(r => r.row?.id === 'fee-156528808241-002')).toBe(false);
  });

  it('ingreso con charges_details vacío y commission > 0 → fallback fee-legacy', () => {
    // Caso edge: payment legacy donde MP no devuelve charges_details
    const rows = mapPaymentToRows({
      id: 999,
      status: 'approved',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT,
      payer: { id: 1 },
      transaction_amount: 1000,
      transaction_details: { net_received_amount: 950 },
      payment_method_id: 'visa',
      point_of_interaction: { type: 'POINT' },
      // charges_details ausente
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(2);
    expect(rows[0].row.id).toBe('pay-999');
    expect(rows[1].row.id).toBe('fee-999-legacy');
    expect(rows[1].row.monto).toBe(-50);
    expect(rows[1].row.tipo).toBe('fee');
  });

  it('ingreso con commission == 0 → SOLO main, sin fee/tax', () => {
    const rows = mapPaymentToRows({
      id: 1234,
      status: 'approved',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT,
      payer: { id: 99 },
      transaction_amount: 5000,
      transaction_details: { net_received_amount: 5000 },
      payment_method_id: 'account_money',
      point_of_interaction: { type: 'CHECKOUT' },
      charges_details: [],
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].row.tipo).toBe('liquidacion');
  });

  it('ingreso INSTORE con coupon (type=coupon) y mp_fee/tax → ignora coupon', () => {
    // Caso real 156568780899: tiene coupon_off de mp→payer (descuento al
    // cliente, NO toca al merchant). Solo emite el fee y tax del collector.
    const rows = mapPaymentToRows({
      id: 156568780899,
      status: 'approved',
      date_created: '2026-05-01T22:11:00.000-04:00',
      collector_id: OUR_ACCOUNT,
      payer: { id: 177378236 },
      transaction_amount: 70000,
      transaction_details: { net_received_amount: 67571 },
      payment_method_id: 'debvisa',
      point_of_interaction: { type: 'INSTORE' },
      description: 'Producto de Neko Sushi',
      charges_details: [
        {
          id: '156568780899-001',
          name: 'coupon_off',
          type: 'coupon',
          accounts: { from: 'mp', to: 'payer' }, // ← descuento al cliente, ignorar
          amounts: { original: 49000, refunded: 0 },
        },
        {
          id: '156568780899-002',
          name: 'mercadopago_fee',
          type: 'fee',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 679, refunded: 0 },
        },
        {
          id: '156568780899-003',
          name: 'tax_withholding-caba',
          type: 'tax',
          accounts: { from: 'collector', to: 'mp' },
          amounts: { original: 1750, refunded: 0 },
          metadata: { mov_detail: 'tax_withholding', mov_financial_entity: 'caba',
                      source_detail: 'iibb_caba_charge' },
        },
      ],
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(3);
    expect(rows[0].row.medio_pago).toBe('qr_debvisa');
    expect(rows[1].row).toMatchObject({ tipo: 'fee', monto: -679 });
    expect(rows[2].row).toMatchObject({ tipo: 'tax', monto: -1750 });
  });

  it('egreso (compra ML, Lucas paga) → SOLO main, sin fee', () => {
    const rows = mapPaymentToRows({
      id: 156521696215,
      status: 'approved',
      date_created: '2026-05-01T15:55:32.000-04:00',
      collector_id: 156793285, // ≠ ourAccount
      payer: { id: OUR_ACCOUNT },
      transaction_amount: 33230.34,
      transaction_details: { net_received_amount: 20683.49 },
      payment_method_id: 'account_money',
      point_of_interaction: { type: 'CHECKOUT' },
      description: 'Rollos Etiquetas',
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toMatchObject({
      id: 'pay-156521696215',
      tipo: 'bank_transfer',
      monto: -33230.34,
      descripcion: 'Rollos Etiquetas',
    });
  });

  it('referencia_id de main, fee y tax es payment.id puro (no external_reference)', () => {
    const rows = mapPaymentToRows({
      id: 999, status: 'approved',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT, payer: { id: 1 },
      transaction_amount: 100, transaction_details: { net_received_amount: 95 },
      payment_method_id: 'visa',
      point_of_interaction: { type: 'POINT' },
      external_reference: 'Venta presencial',
      charges_details: [
        { id: '999-001', name: 'mercadopago_fee', type: 'fee',
          accounts: { from: 'collector', to: 'mp' }, amounts: { original: 5 } },
      ],
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.row.referencia_id).toBe('999');  // crítico para lookup
    }
  });
});

// ─── formatArIso ─────────────────────────────────────────────────────────────

describe('formatArIso', () => {
  it('UTC midnight 2/5 → AR 1/5 21:00', () => {
    expect(formatArIso(new Date('2026-05-02T00:00:00Z'))).toBe('2026-05-01T21:00:00.000-03:00');
  });

  it('UTC 03:00 del 2/5 → AR 1/5 24:00 = 2/5 00:00 AR', () => {
    expect(formatArIso(new Date('2026-05-02T03:00:00Z'))).toBe('2026-05-02T00:00:00.000-03:00');
  });

  it('preserva milisegundos', () => {
    expect(formatArIso(new Date('2026-05-02T03:00:00.123Z'))).toBe('2026-05-02T00:00:00.123-03:00');
  });
});
