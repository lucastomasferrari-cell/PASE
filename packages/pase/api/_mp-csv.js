// Helper compartido para parsear los CSV que devuelve la API de MP:
//   - settlement_report (PARTE C de TASK 0.11): TRANSACTION_TYPE explícito.
//   - release_report (legacy): RECORD_TYPE='release'.
//
// Lo usan mp-process.js y mp-sync.js. Detección automática del formato
// por las columnas del header.

// TRANSACTION_TYPEs del settlement_report mapeados a tipo PASE.
// Cualquier valor no listado se ignora (con log) y NO se inserta.
export const SETTLEMENT_TIPOS = {
  SETTLEMENT: { tipo: 'liquidacion', sign: 1, descDefault: 'Liquidación MP' },
  WITHDRAWAL: { tipo: 'bank_transfer', sign: -1, descDefault: 'Transferencia enviada' },
  PAYOUT:     { tipo: 'bank_transfer', sign: -1, descDefault: 'Retiro a CBU' },
  REFUND:     { tipo: 'refund',        sign: -1, descDefault: 'Reembolso MP' },
  CHARGEBACK: { tipo: 'chargeback',    sign: -1, descDefault: 'Contracargo MP' },
  // Ignorar (no afectan saldo released):
  // - WITHDRAWAL_CANCEL: cancelación de retiro (vuelve al saldo).
  // - DISPUTE: disputa abierta (manejo manual).
};

export const parseListBody = (body) => {
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch {}
  return Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
};

export const isCsv = (f) =>
  (f?.file_name || f?.fileName || f?.name || '').toLowerCase().endsWith('.csv');

export const parseNumero = (raw) => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const normal = s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.')
    : s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s;
  const v = Number(normal);
  return Number.isFinite(v) ? v : null;
};

export const round2 = (v) => Math.round(v * 100) / 100;

// Parsea CSV simple: separador ; o , y comillas opcionales.
export function parseCsv(csvText) {
  if (!csvText) return { header: [], rows: [], sep: ',' };
  const cleanCsv = csvText.replace(/^﻿/, '');
  const lines = cleanCsv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { header: [], rows: [], sep: ',' };
  const sep = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(sep).map(h => h.replace(/^"|"$/g, '').trim().toUpperCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(sep).map(c => c.replace(/^"|"$/g, '').trim());
    rows.push(cells);
  }
  return { header, rows, sep };
}

// Convierte string fecha del CSV a ISO UTC. Si no tiene marcador de TZ,
// asume Argentina (UTC-3) que es lo que MP configura con
// display_timezone='GMT-03' en config del reporte.
export function fechaCsvToIso(rawDate) {
  if (!rawDate) return new Date().toISOString();
  let s = String(rawDate).trim();
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    if (!s.includes('T')) s = s + 'T00:00:00';
    s = s + '-03:00';
  }
  const parsed = new Date(s);
  return !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

// Detecta si el CSV es settlement_report (TRANSACTION_TYPE) o
// release_report (RECORD_TYPE). Devuelve null si no reconoce.
export function detectarFormatoCsv(header) {
  const h = new Set(header);
  if (h.has('TRANSACTION_TYPE')) return 'settlement';
  if (h.has('RECORD_TYPE')) return 'release';
  return null;
}

// Procesa una fila del CSV settlement. Devuelve { skipped, transType,
// motivo, row } donde row es el objeto listo para upsert (id prefix
// "set-{SOURCE_ID}").
export function procesarFilaSettlement(cells, header, localId) {
  const idx = (col) => header.indexOf(col);
  const get = (col) => { const i = idx(col); return i !== -1 ? (cells[i] || '') : ''; };

  const transType = (get('TRANSACTION_TYPE') || '').toUpperCase().trim();
  const map = SETTLEMENT_TIPOS[transType];
  if (!map) return { skipped: true, transType };

  // Monto: SETTLEMENT_NET_AMOUNT (lo que entra/sale del saldo released).
  // Fallback a TRANSACTION_AMOUNT si está vacío (filas pendientes).
  const netRaw = get('SETTLEMENT_NET_AMOUNT') || get('TRANSACTION_AMOUNT');
  const netAbs = Math.abs(parseNumero(netRaw) || 0);
  if (netAbs <= 0) return { skipped: true, transType, motivo: 'monto_cero' };

  const monto = round2(map.sign * netAbs);

  // Fecha: SETTLEMENT_DATE (cuando se libera) preferido, fallback a
  // TRANSACTION_DATE (near-realtime).
  const settlementDate = get('SETTLEMENT_DATE');
  const transactionDate = get('TRANSACTION_DATE');
  const fechaIso = fechaCsvToIso(settlementDate || transactionDate);

  const sourceId = get('SOURCE_ID');
  const extRef = get('EXTERNAL_REFERENCE');
  const paymentMethod = (get('PAYMENT_METHOD') || '').toLowerCase() || null;

  if (!sourceId && !extRef) return { skipped: true, transType, motivo: 'sin_id' };
  const uniqueKey = sourceId || extRef;

  return {
    skipped: false,
    transType,
    row: {
      id: `set-${uniqueKey}`,
      local_id: localId,
      fecha: fechaIso,
      tipo: map.tipo,
      descripcion: map.descDefault,
      monto,
      saldo: null,
      estado: 'approved',
      referencia_id: extRef || sourceId || String(uniqueKey),
      medio_pago: paymentMethod || (map.tipo === 'bank_transfer' ? 'bank_transfer' : null),
    },
  };
}

// Procesa una fila del CSV release (formato legacy). Mantiene comportamiento
// idéntico al pre-PARTE C.
export function procesarFilaRelease(cells, header, localId, i) {
  const idx = (col) => header.indexOf(col);
  const get = (col) => { const ii = idx(col); return ii !== -1 ? (cells[ii] || '') : ''; };

  const tipo = (get('RECORD_TYPE') || '').toLowerCase();
  if (tipo !== 'release') return { skipped: true, recordType: tipo };

  const netCredit = parseNumero(get('NET_CREDIT_AMOUNT')) || 0;
  const netDebit = parseNumero(get('NET_DEBIT_AMOUNT')) || 0;
  if (netCredit <= 0 && netDebit <= 0) return { skipped: true, recordType: tipo, motivo: 'sin_monto' };

  const sourceId = get('SOURCE_ID');
  const extRef = get('EXTERNAL_REFERENCE');
  const rawDate = get('DATE');
  const descripcionRaw = get('DESCRIPTION');
  const uniqueKey = sourceId || `${rawDate}-${extRef || i}`;

  let monto, rowTipo, descripcionDefault;
  if (netDebit > 0) {
    monto = round2(-netDebit);
    rowTipo = 'bank_transfer';
    descripcionDefault = 'Transferencia enviada';
  } else {
    monto = round2(netCredit);
    rowTipo = 'liquidacion';
    descripcionDefault = 'Liquidación MP';
  }

  return {
    skipped: false,
    recordType: tipo,
    row: {
      id: `rr-${uniqueKey}`,
      local_id: localId,
      fecha: fechaCsvToIso(rawDate),
      tipo: rowTipo,
      descripcion: descripcionRaw || descripcionDefault,
      monto,
      saldo: null,
      estado: 'approved',
      referencia_id: extRef || sourceId || String(uniqueKey),
      medio_pago: rowTipo === 'bank_transfer' ? 'bank_transfer' : null,
    },
  };
}
