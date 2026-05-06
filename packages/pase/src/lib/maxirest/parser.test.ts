import { describe, it, expect } from 'vitest';
import { parseCierreMaxirest } from './parser';
import { tokenize } from './tokenizer';
import { parseMontoAR } from './extractors';

// Helpers para construir cierres sintéticos. NO usamos archivos reales
// (sería re-introducir el problema que motivó el refactor: parser
// dependiente de formatos específicos).

function cierreBase(opts: {
  fechaTexto?: string; turnoCampo?: string; turnoHeader?: string;
  cierreHora?: string; aperturaHora?: string; cuit?: string; sucursal?: string;
  ingresos?: string; egresos?: string; saldo?: string;
  medios?: string[];
  pre?: string;
  separadorTurno?: string;
}): string {
  const {
    fechaTexto = 'Lunes 4 de Mayo de 2026',
    turnoCampo = '',
    turnoHeader = 'Turno 2 (Noche)',
    aperturaHora = '18:30',
    cierreHora = '23:09',
    cuit = '30-12345678-9',
    sucursal = 'Neko Villa Crespo',
    ingresos = '$ 100.000,00',
    egresos = '$ 5.000,00',
    saldo = '$ 95.000,00',
    medios = [],
    pre = '',
  } = opts;
  const partes: string[] = [];
  if (pre) partes.push(pre);
  partes.push(`Sucursal: ${sucursal}`);
  partes.push(`CUIT: ${cuit}`);
  partes.push(`${fechaTexto}`);
  partes.push(`${turnoHeader}`);
  if (turnoCampo) partes.push(`Turno: ${turnoCampo}`);
  partes.push(`Apertura: ${aperturaHora}`);
  partes.push(`Cierre: ${cierreHora}`);
  partes.push('Cierre n° 326');
  partes.push('===============================================');
  partes.push('VENTAS POR FORMA DE COBRO');
  for (const m of medios) partes.push(m);
  partes.push('TOTAL VENTAS    100000,00    50');
  partes.push('===============================================');
  partes.push('TOTALES DE CAJA');
  partes.push(`Subtotal Ingresos: ${ingresos}`);
  partes.push(`Subtotal Egresos: ${egresos}`);
  partes.push(`Saldo de Caja: ${saldo}`);
  return partes.join('\n');
}

describe('parseMontoAR', () => {
  it('formato AR con miles y decimales', () => {
    expect(parseMontoAR('$1.234,56')).toBe(1234.56);
    expect(parseMontoAR(' 1.234.567,89 ')).toBeCloseTo(1234567.89);
  });
  it('formato sin miles', () => {
    expect(parseMontoAR('1234,56')).toBe(1234.56);
    expect(parseMontoAR('1234.56')).toBe(1234.56);
  });
  it('vacío o inválido', () => {
    expect(parseMontoAR('')).toBeNull();
    expect(parseMontoAR('abc')).toBeNull();
  });
});

describe('tokenize', () => {
  it('separa header de ventas_por_cobro y totales', () => {
    const t = tokenize(cierreBase({}));
    expect(t.header.length).toBeGreaterThan(0);
    expect(t.ventas_por_cobro).toContain('VENTAS POR FORMA DE COBRO');
    expect(t.totales).toContain('TOTALES DE CAJA');
  });

  it('texto sin anchors → todo queda en header', () => {
    const t = tokenize('Sucursal: X\nCUIT: 30-12345678-9');
    expect(t.header.length).toBeGreaterThan(0);
    expect(t.ventas_por_cobro).toBe('');
  });

  it('tolera "Resumen de Ventas" como anchor de cobros', () => {
    const t = tokenize('foo\nResumen de Ventas\nVisa 100,00 1');
    expect(t.ventas_por_cobro).toContain('Visa');
  });
});

describe('parseCierreMaxirest — turno', () => {
  it('TC1: campo "Turno: Noche" → Noche, alta confianza junto al header', () => {
    const r = parseCierreMaxirest(cierreBase({ turnoCampo: 'Noche', turnoHeader: 'Turno 2 (Noche)' }));
    expect(r.turno.valor).toBe('Noche');
    expect(r.turno.confianza).toBe('alta');
  });

  it('TC2: header con paréntesis y NADA más → media', () => {
    const txt = cierreBase({ turnoHeader: 'Turno 2 (Noche)' }).replace(/Turno: .*/g, '');
    const r = parseCierreMaxirest(txt);
    expect(r.turno.valor).toBe('Noche');
    expect(['alta', 'media']).toContain(r.turno.confianza);
  });

  it('TC3: header con CORCHETES (formato Devoto)', () => {
    const txt = cierreBase({ turnoHeader: 'Turno 2 [Noche ]' }).replace(/Turno: .*/g, '');
    const r = parseCierreMaxirest(txt);
    expect(r.turno.valor).toBe('Noche');
  });

  it('TC4: header con DOS PUNTOS', () => {
    const txt = cierreBase({ turnoHeader: 'Turno 2: Noche' }).replace(/Turno: .*/g, '');
    const r = parseCierreMaxirest(txt);
    expect(r.turno.valor).toBe('Noche');
  });

  it('TC5: header con LLAVES', () => {
    const txt = cierreBase({ turnoHeader: 'Turno 1 {Mediodía}' }).replace(/Turno: .*/g, '');
    const r = parseCierreMaxirest(txt);
    expect(r.turno.valor).toBe('Mediodía');
  });

  it('TC6: campo y header DISCREPAN → gana campo + nota', () => {
    const r = parseCierreMaxirest(cierreBase({
      turnoCampo: 'Mediodía', turnoHeader: 'Turno 2 (Noche)',
    }));
    expect(r.turno.valor).toBe('Mediodía');
    expect(r.turno.nota).toMatch(/Discrepancia|prioriza/i);
  });

  it('TC7: solo deducible por hora → confianza baja + warning', () => {
    const txt = cierreBase({ turnoHeader: '', turnoCampo: '', cierreHora: '23:09' });
    const r = parseCierreMaxirest(txt);
    expect(r.turno.valor).toBe('Noche');
    expect(r.turno.confianza).toBe('baja');
    expect(r.warnings.some(w => w.campo === 'turno')).toBe(true);
  });

  it('TC8: header con número solo y nombre desconocido → fallback al número', () => {
    const txt = cierreBase({ turnoHeader: 'Turno 2 (XYZ)', turnoCampo: '' });
    const r = parseCierreMaxirest(txt);
    expect(r.turno.valor).toBe('Noche');
  });
});

describe('parseCierreMaxirest — local + CUIT', () => {
  it('detecta sucursal y CUIT (sin guiones, 11 dígitos)', () => {
    const r = parseCierreMaxirest(cierreBase({ sucursal: 'Neko Belgrano', cuit: '30-12345678-9' }));
    expect(r.localNombre.valor).toBe('Neko Belgrano');
    expect(r.cuit.valor).toBe('30123456789');
  });

  it('CUIT sin guiones también vale', () => {
    const r = parseCierreMaxirest(cierreBase({ cuit: '30123456789' }));
    expect(r.cuit.valor).toBe('30123456789');
  });

  it('sin sucursal: cae a primera línea significativa', () => {
    const txt = cierreBase({}).replace(/Sucursal: .*/g, '');
    const r = parseCierreMaxirest(txt);
    expect(r.localNombre.valor).not.toBeNull();
  });
});

describe('parseCierreMaxirest — fecha', () => {
  it('detecta "Lunes 4 de Mayo de 2026"', () => {
    const r = parseCierreMaxirest(cierreBase({ fechaTexto: 'Lunes 4 de Mayo de 2026' }));
    expect(r.fecha.valor).toBe('2026-05-04');
  });

  it('detecta DD/MM/YYYY', () => {
    const r = parseCierreMaxirest(cierreBase({ fechaTexto: '04/05/2026' }));
    expect(r.fecha.valor).toBe('2026-05-04');
  });

  it('fecha futura → warning critical', () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const fechaTxt = `${future.getDate()} de ${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][future.getMonth()]} de ${future.getFullYear()}`;
    const r = parseCierreMaxirest(cierreBase({ fechaTexto: fechaTxt }));
    expect(r.warnings.some(w => w.campo === 'fecha' && w.severidad === 'critical')).toBe(true);
  });

  it('sin fecha → critical ausente', () => {
    const txt = `Sucursal: X\nApertura: 18:00\nCierre: 23:00\nVENTAS POR FORMA DE COBRO\nTOTAL 100,00 1`;
    const r = parseCierreMaxirest(txt);
    expect(r.fecha.valor).toBeNull();
    expect(r.warnings.some(w => w.campo === 'fecha' && w.severidad === 'critical')).toBe(true);
  });
});

describe('parseCierreMaxirest — totales coherencia', () => {
  it('ingresos - egresos = saldo → sin warning', () => {
    const r = parseCierreMaxirest(cierreBase({
      ingresos: '$ 100.000,00', egresos: '$ 5.000,00', saldo: '$ 95.000,00',
    }));
    expect(r.warnings.some(w => w.campo === 'totales')).toBe(false);
  });

  it('totales incoherentes → warning', () => {
    const r = parseCierreMaxirest(cierreBase({
      ingresos: '$ 100.000,00', egresos: '$ 5.000,00', saldo: '$ 200.000,00',
    }));
    expect(r.warnings.some(w => w.campo === 'totales')).toBe(true);
  });
});

describe('parseCierreMaxirest — medios', () => {
  it('parsea medios linea por linea', () => {
    const r = parseCierreMaxirest(cierreBase({
      medios: ['VISA 50.000,00 25', 'EFECTIVO 30.000,00 15', 'MASTER 20.000,00 10'],
    }));
    expect(r.ventasPorMedio.valor).not.toBeNull();
    const m = r.ventasPorMedio.valor!;
    expect(m.length).toBe(3);
    expect(m[0]?.raw).toBe('VISA');
    expect(m[0]?.monto).toBe(50000);
    expect(m[0]?.cantidad).toBe(25);
  });

  it('ignora subtotales TARJETAS, OTROS y filas con cant=0', () => {
    const r = parseCierreMaxirest(cierreBase({
      medios: ['VISA 50.000,00 25', 'TARJETAS 50.000,00 25', 'OTROS 0,00 0'],
    }));
    const nombres = (r.ventasPorMedio.valor ?? []).map(m => m.raw);
    expect(nombres).toContain('VISA');
    expect(nombres).not.toContain('TARJETAS');
    expect(nombres).not.toContain('OTROS');
  });

  it('cierre sin medios → ventasPorMedio.valor null', () => {
    const r = parseCierreMaxirest(cierreBase({ medios: [] }));
    expect(r.ventasPorMedio.valor).toBeNull();
  });
});

describe('parseCierreMaxirest — bordes raros', () => {
  it('cierre truncado (<100 chars) → critical', () => {
    const r = parseCierreMaxirest('Sucursal: X');
    expect(r.warnings.some(w => w.severidad === 'critical' && w.campo === 'documento')).toBe(true);
  });

  it('texto vacío → muchos campos ausentes + critical', () => {
    const r = parseCierreMaxirest('');
    expect(r.fecha.valor).toBeNull();
    expect(r.turno.valor).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('encoding raro: caracteres acentuados ñ, í', () => {
    const r = parseCierreMaxirest(cierreBase({ sucursal: 'Cantiña Ñ' }));
    expect(r.localNombre.valor).toBe('Cantiña Ñ');
  });
});

// ─── Independencia de longitud de separadores decorativos ───────────────────
// Cada local de Maxirest emite separadores con distinta cantidad de tildes:
//   Villa Crespo  → 35 tildes
//   Maneki/Balpecia/Devoto → 13 tildes
// El parser debe ser independiente de la longitud específica. Mínimo 3 chars
// consecutivos para considerarlo "decorador"; un guión suelto no cuenta.

function cierreConSeparador(sep: string): string {
  return [
    'Sucursal: Test',
    'CUIT: 30-12345678-9',
    'Lunes 4 de Mayo de 2026',
    'Turno 2 (Noche)',
    'Turno: Noche',
    'Apertura: 18:30',
    'Cierre: 23:09',
    'Cierre n° 100',
    sep,
    'VENTAS POR FORMA DE COBRO',
    sep,
    'EFECTIVO 30000,00 5',
    'TARJETA DEBITO 50000,00 10',
    'RAPPI ONLINE 100000,00 8',
    sep,
    'TOTAL VENTAS 180000,00 23',
    sep,
    'TOTALES DE CAJA',
    'Subtotal Ingresos: $ 180.000,00',
    'Subtotal Egresos: $ 0,00',
    'Saldo de Caja: $ 180.000,00',
  ].join('\n');
}

describe('parseCierreMaxirest — separadores de longitudes distintas', () => {
  it('separador de 3 tildes (mínimo)', () => {
    const r = parseCierreMaxirest(cierreConSeparador('~~~'));
    const m = r.ventasPorMedio.valor!;
    expect(m).not.toBeNull();
    expect(m.length).toBe(3);
    expect(m.map(x => x.raw).sort()).toEqual(['EFECTIVO', 'RAPPI ONLINE', 'TARJETA DEBITO']);
  });

  it('separador de 13 tildes (Maneki/Balpecia/Devoto)', () => {
    const r = parseCierreMaxirest(cierreConSeparador('~~~~~~~~~~~~~'));
    const m = r.ventasPorMedio.valor!;
    expect(m.length).toBe(3);
    expect(m.find(x => x.raw === 'TARJETA DEBITO')?.monto).toBe(50000);
  });

  it('separador de 35 tildes (Villa Crespo)', () => {
    const r = parseCierreMaxirest(cierreConSeparador('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'));
    const m = r.ventasPorMedio.valor!;
    expect(m.length).toBe(3);
    expect(m.find(x => x.raw === 'RAPPI ONLINE')?.cantidad).toBe(8);
  });

  it('separadores mixtos: 3 tildes en una sección, 35 en otra', () => {
    const txt = [
      'Sucursal: Test',
      'CUIT: 30-12345678-9',
      'Lunes 4 de Mayo de 2026',
      'Turno 2 (Noche)',
      'Turno: Noche',
      'Cierre: 23:09',
      '~~~',
      'VENTAS POR FORMA DE COBRO',
      '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      'EFECTIVO 30000,00 5',
      'TARJETA DEBITO 50000,00 10',
      '~~~~~~~~~~~~~',
      'TOTAL VENTAS 80000,00 15',
      '===',
      'TOTALES DE CAJA',
      'Subtotal Ingresos: $ 80.000,00',
    ].join('\n');
    const r = parseCierreMaxirest(txt);
    const m = r.ventasPorMedio.valor!;
    expect(m.length).toBe(2);
    expect(m.map(x => x.raw).sort()).toEqual(['EFECTIVO', 'TARJETA DEBITO']);
  });

  it('separador con iguales (===) también funciona', () => {
    const r = parseCierreMaxirest(cierreConSeparador('========================'));
    expect(r.ventasPorMedio.valor!.length).toBe(3);
  });

  it('separador con guiones (-----) también funciona', () => {
    const r = parseCierreMaxirest(cierreConSeparador('-----------'));
    expect(r.ventasPorMedio.valor!.length).toBe(3);
  });

  it('un guión solo NO es separador (puede ser texto legítimo)', () => {
    // Si "VISA - DEBITO 100,00 1" llegara como línea de medio, NO debería
    // descartarse como decorador.
    const txt = [
      'Sucursal: Test',
      'Lunes 4 de Mayo de 2026',
      'Turno: Noche',
      'Cierre: 23:09',
      'VENTAS POR FORMA DE COBRO',
      'VISA - DEBITO 100,00 1',
      'TOTAL 100,00 1',
      'TOTALES DE CAJA',
      'Subtotal Ingresos: $ 100,00',
    ].join('\n');
    const r = parseCierreMaxirest(txt);
    const m = r.ventasPorMedio.valor!;
    expect(m).not.toBeNull();
    expect(m.length).toBe(1);
    expect(m[0]?.raw).toBe('VISA - DEBITO');
  });
});
