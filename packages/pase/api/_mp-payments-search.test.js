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
  it('skip si status != approved', () => {
    const rows = mapPaymentToRows({ id: 1, status: 'rejected' }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].skipped).toBe(true);
    expect(rows[0].reason).toBe('not_approved');
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

  it('ingreso Point Smart con commission > 0 → main + fee (2 filas)', () => {
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
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(2);
    // Main row
    expect(rows[0].skipped).toBe(false);
    expect(rows[0].row).toMatchObject({
      id: 'pay-157334804646',
      local_id: 1,
      tenant_id: 'tenant-uuid',
      tipo: 'liquidacion',
      monto: 155340.15,
      estado: 'approved',
      descripcion: 'Point Smart — visa',
      medio_pago: 'point_smart_visa',
      referencia_id: '157334804646',
      fecha: '2026-05-01T22:26:00.000-04:00',
    });
    // Fee row
    expect(rows[1].skipped).toBe(false);
    expect(rows[1].row).toMatchObject({
      id: 'fee-157334804646',
      tipo: 'fee',
      monto: -13159.85,           // 168500 - 155340.15
      referencia_id: '157334804646', // mismo que main → permite lookup
      medio_pago: 'point_smart_visa', // hereda POI
      tenant_id: 'tenant-uuid',
      local_id: 1,
    });
    expect(rows[1].row.descripcion).toContain('Comisión');
  });

  it('ingreso CHECKOUT con commission > 0 → main + fee', () => {
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
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(2);
    expect(rows[0].row.medio_pago).toBe('visa');
    expect(rows[1].row.tipo).toBe('fee');
    expect(rows[1].row.monto).toBeCloseTo(-11612.12, 2);
  });

  it('ingreso con commission == 0 (account_money same as net) → SOLO main, sin fee', () => {
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
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0].row.tipo).toBe('liquidacion');
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

  it('ingreso QR (INSTORE) → main con medio qr_* + fee', () => {
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
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(2);
    expect(rows[0].row.tipo).toBe('liquidacion');
    expect(rows[0].row.medio_pago).toBe('qr_debvisa');
    expect(rows[1].row.tipo).toBe('fee');
    expect(rows[1].row.medio_pago).toBe('qr_debvisa');  // hereda
    expect(rows[1].row.monto).toBe(-2429);
  });

  it('referencia_id de main y fee es payment.id como string puro (no external_reference)', () => {
    const rows = mapPaymentToRows({
      id: 999, status: 'approved',
      date_created: '2026-05-01T00:00:00-04:00',
      collector_id: OUR_ACCOUNT, payer: { id: 1 },
      transaction_amount: 100, transaction_details: { net_received_amount: 95 },
      payment_method_id: 'visa',
      point_of_interaction: { type: 'POINT' },
      external_reference: 'Venta presencial',
    }, CRED, OUR_ACCOUNT);
    expect(rows).toHaveLength(2);
    expect(rows[0].row.referencia_id).toBe('999');
    expect(rows[1].row.referencia_id).toBe('999');  // crítico para lookup
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
