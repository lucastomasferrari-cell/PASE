import { describe, it, expect } from 'vitest';
import { parseCierre } from './parser';

// ── Tests sintéticos (5) ───────────────────────────────────────────────────
//
// Cubren las decisiones del parser; no se atan a un local específico.
// Si todos pasan, el parser cumple su contrato. Los tests con cierres
// reales abajo son la red de seguridad para regresiones.

describe('parseCierre — sintéticos', () => {
  it('1. cierre completo bien formado → ok', () => {
    const txt = [
      'Lunes 4 de Mayo de 2026',
      'Turno: Noche',
      'VENTAS POR FORMA DE COBRO',
      'Forma de cobro Total Cant',
      'EFECTIVO 100,00 1',
      'TARJETA 200,00 2',
      'TOTAL 300,00 3',
    ].join('\n');
    const r = parseCierre(txt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.turno).toBe('noche');
    expect(r.data.fecha.getFullYear()).toBe(2026);
    expect(r.data.fecha.getMonth()).toBe(4); // mayo (0-indexed)
    expect(r.data.fecha.getDate()).toBe(4);
    expect(r.data.medios.length).toBe(2);
  });

  it('2. cierre sin ninguna línea de turno → error en turno', () => {
    const txt = [
      'Lunes 4 de Mayo de 2026',
      'VENTAS POR FORMA DE COBRO',
      'Forma de cobro Total Cant',
      'EFECTIVO 100,00 1',
    ].join('\n');
    const r = parseCierre(txt);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.find(e => e.campo === 'turno')).toBeDefined();
  });

  it('2b. cierre con formato "Turno 1 (AM)" → mediodia (formato René)', () => {
    const txt = [
      'Viernes 1 de Mayo de 2026',
      'Turno 1 (AM )',
      'VENTAS POR FORMA DE COBRO',
      'Forma de cobro Total Cant',
      'EFECTIVO 100,00 1',
    ].join('\n');
    const r = parseCierre(txt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.turno).toBe('mediodia');
  });

  it('2c. cierre con formato "Turno 2 (PM)" → noche', () => {
    const txt = [
      'Viernes 1 de Mayo de 2026',
      'Turno 2 (PM)',
      'VENTAS POR FORMA DE COBRO',
      'Forma de cobro Total Cant',
      'EFECTIVO 100,00 1',
    ].join('\n');
    const r = parseCierre(txt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.turno).toBe('noche');
  });

  it('2d. cierre con formato "Turno 2 (Noche)" → noche (compat)', () => {
    const txt = [
      'Lunes 4 de Mayo de 2026',
      'Turno 2 (Noche)',
      'VENTAS POR FORMA DE COBRO',
      'Forma de cobro Total Cant',
      'EFECTIVO 100,00 1',
    ].join('\n');
    const r = parseCierre(txt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.turno).toBe('noche');
  });

  it('3. cierre sin sección "VENTAS POR FORMA DE COBRO" → error en medios', () => {
    const txt = [
      'Lunes 4 de Mayo de 2026',
      'Turno: Noche',
      'OTRA SECCION',
    ].join('\n');
    const r = parseCierre(txt);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.find(e => e.campo === 'medios')).toBeDefined();
  });

  it('4. separadores de distintas longitudes (3, 13, 35 tildes) → todos parsean', () => {
    function build(sep: string): string {
      return [
        '4 de Mayo de 2026',
        'Turno: Noche',
        'VENTAS POR FORMA DE COBRO',
        sep,
        'Forma de cobro Total Cant',
        sep,
        'EFECTIVO 100,00 1',
        'TOTAL 100,00 1',
      ].join('\n');
    }
    for (const sep of ['~~~', '~~~~~~~~~~~~~', '~'.repeat(35), '======', '----']) {
      const r = parseCierre(build(sep));
      expect(r.ok, `separador "${sep}"`).toBe(true);
      if (!r.ok) continue;
      expect(r.data.medios.length).toBe(1);
    }
  });

  it('5. paréntesis o corchetes en "Turno N (...)" no afectan: usamos "Turno:"', () => {
    const con = (header: string) => [
      '4 de Mayo de 2026',
      header,
      'Turno: Noche',
      'VENTAS POR FORMA DE COBRO',
      'Forma de cobro Total Cant',
      'EFECTIVO 100,00 1',
    ].join('\n');
    for (const h of ['Turno 2 (Noche)', 'Turno 2 [Noche]', 'Turno 2 {Noche}', 'Turno 2: Noche']) {
      const r = parseCierre(con(h));
      expect(r.ok, `header "${h}"`).toBe(true);
      if (!r.ok) continue;
      expect(r.data.turno).toBe('noche');
    }
  });
});

// ── Tests con cierres reales (4) ───────────────────────────────────────────
//
// Cuatro cierres pegados textualmente desde mails de los locales.
// Si en el futuro Maxirest cambia el formato y rompe alguno, el test
// alerta y se ajusta el parser sin reescribir la lógica entera.

const VILLA_CRESPO = `Lucas Ferrari
LUCAS TOMAS FERRARI
Juan Ramirez de Velasco 471
Sucursal: Neko Sushi
IVA: Resp. Inscripto   CUIT: 20-39908753-9
TOTALES DEL DIA:
Lunes 4 de Mayo de 2026
Turno 2  (Noche               )
Cierre nº   326.
Apertura: 18:18 - Usuario: SUPERVISOR
  Cierre: 23:09 - Usuario: SUPERVISOR
MOVIMIENTOS DE CAJA
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Conc.   Detalle                    Total
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Turno: Noche
INGRESOS
~~~~~~~~
AJUSTE  APERTURA SALDO CA      72251.51
VENTAS  Recaudación            28800.00
                              ==========
        SUBTOTAL INGRESOS:     101051.51
EGRESOS
~~~~~~~~
EGR.VAR envio degustacion      -14000.00
                              ==========
         SUBTOTAL EGRESOS:    -101000.00
                              ==========
          TOTAL INGRESOS:     101051.51
                              ==========
           TOTAL EGRESOS:    -101000.00
                              ==========
           SALDO DE CAJA:         51.51
VENTAS POR FORMA DE COBRO
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Forma de cobro           Total Cant
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
PEYA ONLINE              140996.00    2
EFECTIVO SALON            28800.00    1
RAPPI ONLINE             420500.00    5
                    ===============
TOTAL                    590296.00    8
RESUMEN`;

const MANEKI = `Maneki
BETA GASTRONOMICA
Soler 5874
Sucursal: Maneki
IVA: Resp. Inscripto   CUIT: 30-71799401-5
TOTALES DEL DIA:
Viernes 1 de Mayo de 2026
Turno 2  (Noche               )
Cierre nº   461.
MOVIMIENTOS DE CAJA
~~~~~~~~~~~~~~
Conc.   Detalle                    Total
~~~~~~~~~~~~~~
Turno: Noche
VENTAS POR FORMA DE COBRO
~~~~~~~~~~~~~
Forma de cobro           Total Cant
~~~~~~~~~~~~~
TARJETA DEBITO            87600.00    1
RAPPI ONLINE            1147493.29   19
TARJETA CREDITO          162300.00    2
TUCAN ONLINE             124630.00    3
                    ===============
TOTAL                   1522023.29   25
RESUMEN`;

const BALPECIA = `BALPECIA
Balpecia srl
La pampa 1395
Sucursal: neko belg
IVA: Resp. Inscripto CUIT: 33-71696452-9
TOTALES DEL DIA:
Lunes 4 de Mayo de 2026
Turno 2 [Noche ]
Cierre n| 1443.
Apertura: 17:14 - Usuario: SUPERVISOR
Cierre: 23:31 - Usuario: SUPERVISOR
MOVIMIENTOS DE CAJA
~~~~~~~~~~~~~~
Turno: Noche
VENTAS POR FORMA DE COBRO
~~~~~~~~~~~~~
Forma de cobro Total Cant
~~~~~~~~~~~~~
Efectivo 169200.00 2
Point MP 258300.00 2
MP Delivery 29500.00 1
PEYA Online 139000.00 2
Rappi 58000.00 1
===============
TOTAL 654000.00 8
RESUMEN`;

const DEVOTO = `Neko Sushi
Beta Gastronómica
Mercedes 3940
Sucursal: DEVOTO SALON
IVA: Resp. Inscripto CUIT: 30-71799401-5
TOTALES DEL DIA:
Domingo 3 de Mayo de 2026
Turno 2 [Noche ]
Cierre n| 229.
Turno: Noche
VENTAS POR FORMA DE COBRO
~~~~~~~~~~~~~
Forma de cobro Total Cant
~~~~~~~~~~~~~
Efectivo 331840.00 4
RAPPI Online 161675.00 2
===============
TOTAL 493515.00 6
RESUMEN`;

describe('parseCierre — cierres reales', () => {
  it('Villa Crespo (4-may-2026, separador 35 tildes, paréntesis) → 3 medios', () => {
    const r = parseCierre(VILLA_CRESPO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.fecha.getDate()).toBe(4);
    expect(r.data.fecha.getMonth()).toBe(4); // mayo
    expect(r.data.turno).toBe('noche');
    expect(r.data.medios.length).toBe(3);
    expect(r.data.medios.map(m => m.nombre).sort()).toEqual([
      'EFECTIVO SALON', 'PEYA ONLINE', 'RAPPI ONLINE',
    ]);
    expect(r.data.medios.find(m => m.nombre === 'PEYA ONLINE')?.monto).toBe(140996);
  });

  it('Maneki (1-may-2026, separador 13 tildes, paréntesis) → 4 medios', () => {
    const r = parseCierre(MANEKI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.fecha.getDate()).toBe(1);
    expect(r.data.medios.length).toBe(4);
    expect(r.data.medios.map(m => m.nombre).sort()).toEqual([
      'RAPPI ONLINE', 'TARJETA CREDITO', 'TARJETA DEBITO', 'TUCAN ONLINE',
    ]);
    expect(r.data.medios.find(m => m.nombre === 'RAPPI ONLINE')?.cantidad).toBe(19);
  });

  it('Balpecia/Belgrano (4-may-2026, separador 13 tildes, corchetes) → 5 medios', () => {
    const r = parseCierre(BALPECIA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.medios.length).toBe(5);
    expect(r.data.medios.map(m => m.nombre).sort()).toEqual([
      'Efectivo', 'MP Delivery', 'PEYA Online', 'Point MP', 'Rappi',
    ]);
    expect(r.data.medios.find(m => m.nombre === 'MP Delivery')?.monto).toBe(29500);
  });

  it('Devoto (3-may-2026, separador 13 tildes, corchetes) → 2 medios', () => {
    const r = parseCierre(DEVOTO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.fecha.getDate()).toBe(3);
    expect(r.data.medios.length).toBe(2);
    expect(r.data.medios.map(m => m.nombre).sort()).toEqual(['Efectivo', 'RAPPI Online']);
    expect(r.data.medios.find(m => m.nombre === 'Efectivo')?.cantidad).toBe(4);
  });
});
