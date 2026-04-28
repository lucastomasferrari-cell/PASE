// Tests del parser de settlement_report de MP. El bug previo (Math.abs +
// map.sign) convertía SETTLEMENTs negativos en liquidaciones positivas,
// mostrando egresos como ingresos en Conciliación MP.
//
// El archivo bajo prueba vive en api/, fuera de src/. Vitest acepta el
// import relativo siempre que pueda resolver los .js a través de Node ESM.

import { describe, it, expect } from "vitest";
import { procesarFilaSettlement, procesarFilaRelease } from "../../api/_mp-csv.js";

const HEADER = [
  "TRANSACTION_TYPE",
  "SETTLEMENT_NET_AMOUNT",
  "TRANSACTION_AMOUNT",
  "SETTLEMENT_DATE",
  "TRANSACTION_DATE",
  "SOURCE_ID",
  "EXTERNAL_REFERENCE",
  "PAYMENT_METHOD",
];

const row = (vals: Record<string, string>) =>
  HEADER.map((h) => vals[h] ?? "");

describe("procesarFilaSettlement — signo respetado del CSV", () => {
  it("SETTLEMENT con NET +1000 → liquidacion +1000", () => {
    const cells = row({
      TRANSACTION_TYPE: "SETTLEMENT",
      SETTLEMENT_NET_AMOUNT: "1000",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "abc1",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("liquidacion");
    expect(r.row?.monto).toBe(1000);
    expect(r.row?.descripcion).toBe("Liquidación MP");
  });

  it("SETTLEMENT con NET -500 → bank_transfer -500 (regresión del bug)", () => {
    const cells = row({
      TRANSACTION_TYPE: "SETTLEMENT",
      SETTLEMENT_NET_AMOUNT: "-500",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "abc2",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("bank_transfer");
    expect(r.row?.monto).toBe(-500);
    expect(r.row?.descripcion).toBe("Egreso consolidado MP");
  });

  it("SETTLEMENT con NET en formato argentino con coma decimal y signo negativo", () => {
    // Formato típico de MP: '-538.839,38' (separador miles=., decimal=,).
    const cells = row({
      TRANSACTION_TYPE: "SETTLEMENT",
      SETTLEMENT_NET_AMOUNT: "-538.839,38",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "real-1",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("bank_transfer");
    expect(r.row?.monto).toBe(-538839.38);
  });

  it("WITHDRAWAL con NET 100 → bank_transfer -100", () => {
    const cells = row({
      TRANSACTION_TYPE: "WITHDRAWAL",
      SETTLEMENT_NET_AMOUNT: "100",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "wd1",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("bank_transfer");
    expect(r.row?.monto).toBe(-100);
    expect(r.row?.descripcion).toBe("Transferencia enviada");
  });

  it("WITHDRAWAL con NET -100 (signo ya correcto en CSV) → bank_transfer -100", () => {
    const cells = row({
      TRANSACTION_TYPE: "WITHDRAWAL",
      SETTLEMENT_NET_AMOUNT: "-100",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "wd2",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("bank_transfer");
    expect(r.row?.monto).toBe(-100);
  });

  it("REFUND con NET 50 → refund -50", () => {
    const cells = row({
      TRANSACTION_TYPE: "REFUND",
      SETTLEMENT_NET_AMOUNT: "50",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "rf1",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("refund");
    expect(r.row?.monto).toBe(-50);
  });

  it("PAYOUT con NET 200 → bank_transfer -200", () => {
    const cells = row({
      TRANSACTION_TYPE: "PAYOUT",
      SETTLEMENT_NET_AMOUNT: "200",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "po1",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("bank_transfer");
    expect(r.row?.monto).toBe(-200);
  });

  it("CHARGEBACK con NET 75 → chargeback -75", () => {
    const cells = row({
      TRANSACTION_TYPE: "CHARGEBACK",
      SETTLEMENT_NET_AMOUNT: "75",
      SETTLEMENT_DATE: "2026-04-28",
      SOURCE_ID: "cb1",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("chargeback");
    expect(r.row?.monto).toBe(-75);
  });

  it("TRANSACTION_TYPE desconocido → skipped", () => {
    const cells = row({
      TRANSACTION_TYPE: "UNKNOWN_FOO",
      SETTLEMENT_NET_AMOUNT: "100",
      SOURCE_ID: "x",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBe(true);
    expect(r.transType).toBe("UNKNOWN_FOO");
  });

  it("monto cero → skipped", () => {
    const cells = row({
      TRANSACTION_TYPE: "SETTLEMENT",
      SETTLEMENT_NET_AMOUNT: "0",
      SOURCE_ID: "z",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBe(true);
    expect(r.motivo).toBe("monto_cero");
  });

  it("sin SOURCE_ID ni EXTERNAL_REFERENCE → skipped", () => {
    const cells = row({
      TRANSACTION_TYPE: "SETTLEMENT",
      SETTLEMENT_NET_AMOUNT: "100",
    });
    const r = procesarFilaSettlement(cells, HEADER, 1);
    expect(r.skipped).toBe(true);
    expect(r.motivo).toBe("sin_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tests del parser release_report. Cubre los DESCRIPTION reales que MP
// entrega en el reporte para los eventos de movimiento del saldo.
// reserve_for_payout viene en par y debe skippearse para no inflar el
// conteo de movimientos por transferencia (smoke 28/04: Outon -$223.263
// y The Good Selection -$903.249 venían cada una con 3 filas).
// ─────────────────────────────────────────────────────────────────────────

const RELEASE_HEADER = [
  "DATE",
  "SOURCE_ID",
  "EXTERNAL_REFERENCE",
  "RECORD_TYPE",
  "DESCRIPTION",
  "NET_CREDIT_AMOUNT",
  "NET_DEBIT_AMOUNT",
];

const releaseRow = (vals: Record<string, string>) =>
  RELEASE_HEADER.map((h) => vals[h] ?? "");

describe("procesarFilaRelease — eventos de release_report", () => {
  it("payment con NET_CREDIT +1000 → liquidacion +1000 'Liquidación MP'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T19:46:08.000-04:00",
      SOURCE_ID: "154548450459",
      EXTERNAL_REFERENCE: "Venta presencial",
      RECORD_TYPE: "release",
      DESCRIPTION: "payment",
      NET_CREDIT_AMOUNT: "1000",
      NET_DEBIT_AMOUNT: "0",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("liquidacion");
    expect(r.row?.monto).toBe(1000);
    expect(r.row?.descripcion).toBe("Liquidación MP");
    expect(r.row?.id).toBe("rr-154548450459");
  });

  it("payout con NET_DEBIT 903249.27 → bank_transfer -903249.27 'Transferencia enviada'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T10:02:47.000-04:00",
      SOURCE_ID: "156629480328",
      EXTERNAL_REFERENCE: "67REZ8NPQOW5Q65R94KVGO",
      RECORD_TYPE: "release",
      DESCRIPTION: "payout",
      NET_CREDIT_AMOUNT: "0",
      NET_DEBIT_AMOUNT: "903249.27",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("bank_transfer");
    expect(r.row?.monto).toBe(-903249.27);
    expect(r.row?.descripcion).toBe("Transferencia enviada");
    expect(r.row?.medio_pago).toBe("bank_transfer");
  });

  it("reserve_for_payout (debit) → skipped 'reserve_intermediate'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T10:02:44.000-04:00",
      SOURCE_ID: "156629480328",
      RECORD_TYPE: "release",
      DESCRIPTION: "reserve_for_payout",
      NET_CREDIT_AMOUNT: "0",
      NET_DEBIT_AMOUNT: "903249.27",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBe(true);
    expect(r.motivo).toBe("reserve_intermediate");
  });

  it("reserve_for_payout (credit cancela) → skipped 'reserve_intermediate'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T10:02:47.000-04:00",
      SOURCE_ID: "156629480328",
      RECORD_TYPE: "release",
      DESCRIPTION: "reserve_for_payout",
      NET_CREDIT_AMOUNT: "903249.27",
      NET_DEBIT_AMOUNT: "0",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBe(true);
    expect(r.motivo).toBe("reserve_intermediate");
  });

  it("refund con NET_DEBIT 50 → refund -50 'Reembolso MP'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T20:00:00.000-04:00",
      SOURCE_ID: "rf-9001",
      RECORD_TYPE: "release",
      DESCRIPTION: "refund",
      NET_CREDIT_AMOUNT: "0",
      NET_DEBIT_AMOUNT: "50",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("refund");
    expect(r.row?.monto).toBe(-50);
    expect(r.row?.descripcion).toBe("Reembolso MP");
  });

  it("chargeback con NET_DEBIT 75 → chargeback -75 'Contracargo MP'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T20:00:00.000-04:00",
      SOURCE_ID: "cb-9001",
      RECORD_TYPE: "release",
      DESCRIPTION: "chargeback",
      NET_CREDIT_AMOUNT: "0",
      NET_DEBIT_AMOUNT: "75",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("chargeback");
    expect(r.row?.monto).toBe(-75);
    expect(r.row?.descripcion).toBe("Contracargo MP");
  });

  it("asset_management con NET_CREDIT 1461.82 → liquidacion +1461.82 'Rendimiento MP'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T03:30:45.000-03:00",
      SOURCE_ID: "1742902328991",
      RECORD_TYPE: "release",
      DESCRIPTION: "asset_management",
      NET_CREDIT_AMOUNT: "1461.82",
      NET_DEBIT_AMOUNT: "0",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.tipo).toBe("liquidacion");
    expect(r.row?.monto).toBe(1461.82);
    expect(r.row?.descripcion).toBe("Rendimiento MP");
  });

  it("RECORD_TYPE no-release → skipped", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T10:00:00.000-04:00",
      SOURCE_ID: "x",
      RECORD_TYPE: "settlement",
      DESCRIPTION: "payment",
      NET_CREDIT_AMOUNT: "100",
      NET_DEBIT_AMOUNT: "0",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBe(true);
  });

  it("ambos NET en cero → skipped 'sin_monto'", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T10:00:00.000-04:00",
      SOURCE_ID: "x",
      RECORD_TYPE: "release",
      DESCRIPTION: "payment",
      NET_CREDIT_AMOUNT: "0",
      NET_DEBIT_AMOUNT: "0",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBe(true);
    expect(r.motivo).toBe("sin_monto");
  });

  it("payment con NET_CREDIT formato argentino '92.941,20' → liquidacion +92941.20", () => {
    const cells = releaseRow({
      DATE: "2026-04-27T21:56:54.000-04:00",
      SOURCE_ID: "155715352055",
      EXTERNAL_REFERENCE: "Venta presencial",
      RECORD_TYPE: "release",
      DESCRIPTION: "payment",
      NET_CREDIT_AMOUNT: "92.941,20",
      NET_DEBIT_AMOUNT: "0",
    });
    const r = procesarFilaRelease(cells, RELEASE_HEADER, 1, 0);
    expect(r.skipped).toBeFalsy();
    expect(r.row?.monto).toBe(92941.2);
    expect(r.row?.tipo).toBe("liquidacion");
  });
});
