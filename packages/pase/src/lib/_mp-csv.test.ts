// Tests del parser de settlement_report de MP. El bug previo (Math.abs +
// map.sign) convertía SETTLEMENTs negativos en liquidaciones positivas,
// mostrando egresos como ingresos en Conciliación MP.
//
// El archivo bajo prueba vive en api/, fuera de src/. Vitest acepta el
// import relativo siempre que pueda resolver los .js a través de Node ESM.

import { describe, it, expect } from "vitest";
import { procesarFilaSettlement } from "../../api/_mp-csv.js";

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
