import { describe, it, expect } from "vitest";
import {
  numeroALetras,
  splitPagos,
  construirReciboMensual,
} from "./recibos";

describe("numeroALetras", () => {
  it("casos básicos", () => {
    expect(numeroALetras(0)).toBe("cero");
    expect(numeroALetras(1)).toBe("uno");
    expect(numeroALetras(15)).toBe("quince");
    expect(numeroALetras(21)).toBe("veintiuno");
    expect(numeroALetras(31)).toBe("treinta y uno");
    expect(numeroALetras(100)).toBe("cien");
    expect(numeroALetras(101)).toBe("ciento uno");
    expect(numeroALetras(500)).toBe("quinientos");
  });

  it("miles y millones", () => {
    expect(numeroALetras(1000)).toBe("mil");
    expect(numeroALetras(500000)).toBe("quinientos mil");
    expect(numeroALetras(2000000)).toBe("dos millones");
    expect(numeroALetras(1014583)).toBe("un millón catorce mil quinientos ochenta y tres");
  });

  it("ignora decimales y signo (pesos enteros)", () => {
    expect(numeroALetras(1234.99)).toBe(numeroALetras(1234));
    expect(numeroALetras(-50)).toBe("cincuenta");
  });
});

describe("splitPagos", () => {
  it("agrupa por medio (efectivo / MP) con monto positivo", () => {
    const pagos = splitPagos([
      { cuenta: "Caja Efectivo", importe: -514583 },
      { cuenta: "Mercado Pago", importe: -500000 },
    ]);
    const efectivo = pagos.find(p => p.medio === "Efectivo");
    const mp = pagos.find(p => p.medio === "Mercado Pago");
    expect(efectivo?.monto).toBe(514583);
    expect(mp?.monto).toBe(500000);
  });

  it("suma 2 movimientos del mismo medio", () => {
    const pagos = splitPagos([
      { cuenta: "Caja Efectivo", importe: -1000 },
      { cuenta: "Caja Efectivo", importe: -500 },
    ]);
    expect(pagos.length).toBe(1);
    expect(pagos[0]!.monto).toBe(1500);
  });
});

describe("construirReciboMensual", () => {
  const empleado = { nombre: "Tintilay, Ciro", cuil: "20-38xxxxxx-7", puesto: "Cocinero", ingreso: "2024-03-01" };
  const negocio = { razonSocial: "Neko Sushi", cuit: "30-71xxxxxx-4", direccion: "Av. Corrientes 1234", sucursal: "SUSHIMAN" };

  it("arma conceptos, total (= pagado) y letras", () => {
    const r = construirReciboMensual({
      liq: {
        sueldo_base: 1070000, total_horas_extras: 26750, monto_presentismo: 53500,
        descuento_ausencias: 35667, adelantos: 100000, total_a_pagar: 1014583,
        cuota_num: 1, cuotas_total: 1,
      },
      movs: [
        { cuenta: "Caja Efectivo", importe: -514583 },
        { cuenta: "Mercado Pago", importe: -500000 },
      ],
      empleado, negocio, mes: 6, anio: 2026, modo: "Mensual",
    });
    expect(r.tipo).toBe("mensual");
    expect(r.periodo).toBe("Junio 2026");
    // total = suma de pagos reales
    expect(r.total).toBe(1014583);
    expect(r.totalEnLetras).toContain("pesos");
    // conceptos incluyen base, hs extras, presentismo, faltas, adelantos
    const labels = r.conceptos.map(c => c.label);
    expect(labels).toContain("Sueldo base");
    expect(labels).toContain("Horas extras");
    expect(labels).toContain("Presentismo");
    expect(labels).toContain("Faltas");
    expect(labels).toContain("Adelantos");
    // signo de faltas/adelantos negativo
    expect(r.conceptos.find(c => c.label === "Faltas")?.signo).toBe("-");
    expect(r.conceptos.find(c => c.label === "Adelantos")?.signo).toBe("-");
    // pagos split
    expect(r.pagos.length).toBe(2);
  });

  it("quincenal → período con Q1/Q2", () => {
    const r = construirReciboMensual({
      liq: { sueldo_base: 500000, total_a_pagar: 500000, cuota_num: 2, cuotas_total: 2 },
      movs: [{ cuenta: "Caja Efectivo", importe: -500000 }],
      empleado, negocio, mes: 7, anio: 2026,
    });
    expect(r.periodo).toBe("Q2 Julio 2026");
  });
});
