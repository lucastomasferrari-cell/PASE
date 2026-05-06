// ────────────────────────────────────────────────────────────────────────────
// Capa 3 — Validadores cruzados
//
// Reciben el resultado parcial del parser y producen warnings con
// severidad. La UI usa los warnings para:
//   - bloquear el botón "Importar" si hay algún 'critical' sin atender
//   - mostrar mensajes contextuales sobre cada campo
//
// Severidad:
//   info     — informativo, no bloquea
//   warning  — atención, no bloquea
//   critical — bloquea importar hasta que el usuario edite o confirme
// ────────────────────────────────────────────────────────────────────────────

import type { CierreMaxirest, Warning } from './types';

const CRITICOS_AUSENTES: Array<keyof CierreMaxirest> = ['fecha', 'turno'];

export function validarCierre(c: CierreMaxirest): Warning[] {
  const ws: Warning[] = [];

  // ── Campos críticos ausentes ─────────────────────────────────────────────
  for (const k of CRITICOS_AUSENTES) {
    const campo = c[k];
    // CierreMaxirest tiene también arrays/objetos, ignoramos esos casos.
    if (typeof campo !== 'object' || campo == null || !('valor' in campo)) continue;
    if (campo.valor == null) {
      ws.push({
        campo: String(k),
        severidad: 'critical',
        mensaje: `Falta ${String(k)}. Cargalo manualmente.`,
      });
    }
  }

  // ── Coherencia turno + hora cierre ───────────────────────────────────────
  const turno = c.turno.valor;
  const horaCierre = c.horaCierre.valor;
  if (turno && horaCierre) {
    const h = parseInt(horaCierre.split(':')[0] ?? '0', 10);
    if (turno === 'Mediodía' && h >= 20) {
      ws.push({
        campo: 'turno',
        severidad: 'warning',
        mensaje: `Turno mediodía con cierre a las ${horaCierre} es inusual. Verificá.`,
      });
    }
    if (turno === 'Noche' && h > 0 && h < 14) {
      ws.push({
        campo: 'turno',
        severidad: 'warning',
        mensaje: `Turno noche con cierre a las ${horaCierre} es inusual. Verificá.`,
      });
    }
  }

  // ── Fecha futura ─────────────────────────────────────────────────────────
  if (c.fecha.valor) {
    const f = new Date(`${c.fecha.valor}T00:00:00`);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    if (f.getTime() > hoy.getTime()) {
      ws.push({
        campo: 'fecha',
        severidad: 'critical',
        mensaje: `La fecha ${c.fecha.valor} está en el futuro. ¿Es correcta?`,
      });
    }
    const diffDias = Math.floor((hoy.getTime() - f.getTime()) / 86_400_000);
    if (diffDias > 30) {
      ws.push({
        campo: 'fecha',
        severidad: 'warning',
        mensaje: `La fecha ${c.fecha.valor} es de hace ${diffDias} días. Confirmá que importás un cierre viejo a propósito.`,
      });
    }
  }

  // ── Coherencia totales: ingresos - egresos = saldo (con tolerancia $1) ──
  const ing = c.totalIngresos.valor;
  const egr = c.totalEgresos.valor;
  const sal = c.saldoCaja.valor;
  if (ing != null && egr != null && sal != null) {
    const calc = ing - egr;
    const diff = Math.abs(calc - sal);
    if (diff > 1) {
      ws.push({
        campo: 'totales',
        severidad: 'warning',
        mensaje: `Ingresos − Egresos = ${calc.toFixed(2)} pero saldo declarado es ${sal.toFixed(2)} (diff ${diff.toFixed(2)}).`,
      });
    }
  }

  // ── Medios de cobro: total debe ser ≈ ingresos ───────────────────────────
  const medios = c.ventasPorMedio.valor;
  if (medios && medios.length > 0 && ing != null) {
    const sumMedios = medios.reduce((s, m) => s + m.monto, 0);
    const diff = Math.abs(sumMedios - ing);
    // Tolerancia 1% o $5 (lo que sea mayor).
    const tol = Math.max(5, Math.abs(ing) * 0.01);
    if (diff > tol) {
      ws.push({
        campo: 'ventasPorMedio',
        severidad: 'info',
        mensaje: `Suma de medios = ${sumMedios.toFixed(2)} difiere de Ingresos = ${ing.toFixed(2)}. Puede ser por egresos cargados como medio. Verificá.`,
      });
    }
  }

  // ── Confianza global baja ────────────────────────────────────────────────
  if (c.turno.confianza === 'baja') {
    ws.push({
      campo: 'turno',
      severidad: 'warning',
      mensaje: 'Turno deducido por hora de cierre. Recomendamos verificar manualmente.',
    });
  }

  // ── Documento sin tokens / vacío ─────────────────────────────────────────
  if (c.tokens.raw.trim().length < 100) {
    ws.push({
      campo: 'documento',
      severidad: 'critical',
      mensaje: 'El texto pegado es muy corto. ¿Está completo?',
    });
  }

  return ws.sort((a, b) => severidadPeso(b.severidad) - severidadPeso(a.severidad));
}

function severidadPeso(s: Warning['severidad']): number {
  return s === 'critical' ? 3 : s === 'warning' ? 2 : 1;
}
