import { db } from '../lib/supabase';

// Reportes operativos — RPCs SECURITY DEFINER que validan
// auth_tiene_permiso('comanda.reportes.ver') o auth_es_superadmin().

export interface VentasPorCanal {
  canal_id: number;
  canal_nombre: string;
  canal_color: string | null;
  cantidad_ventas: number;
  total_ventas: number;
  ticket_promedio: number;
  comision_pct: number;
  comision_total: number;
  margen_neto: number;
}

export interface TopProducto {
  item_id: number;
  item_nombre: string;
  item_emoji: string | null;
  cantidad_vendida: number;
  total_facturado: number;
}

export interface TiemposReporte {
  tiempo_promedio_cocina_seg: number | null;
  tiempo_promedio_cobro_seg: number | null;
  cantidad_ventas: number;
}

export interface KpisPeriodo {
  total_ventas: number;
  cantidad_ventas: number;
  ticket_promedio: number;
  cantidad_productos: number;
}

export type PeriodoReporte = 'hoy' | 'ayer' | 'semana' | 'mes' | 'trimestre' | 'custom';

export function getRangoPeriodo(p: PeriodoReporte, customDesde?: string, customHasta?: string): { desde: string; hasta: string } {
  const now = new Date();
  const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  switch (p) {
    case 'hoy':
      return { desde: startOfDay(now).toISOString(), hasta: endOfDay(now).toISOString() };
    case 'ayer': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return { desde: startOfDay(y).toISOString(), hasta: endOfDay(y).toISOString() };
    }
    case 'semana': {
      const w = new Date(now); w.setDate(w.getDate() - 7);
      return { desde: startOfDay(w).toISOString(), hasta: endOfDay(now).toISOString() };
    }
    case 'mes': {
      const m = new Date(now); m.setDate(m.getDate() - 30);
      return { desde: startOfDay(m).toISOString(), hasta: endOfDay(now).toISOString() };
    }
    case 'trimestre': {
      const q = new Date(now); q.setDate(q.getDate() - 90);
      return { desde: startOfDay(q).toISOString(), hasta: endOfDay(now).toISOString() };
    }
    case 'custom':
      return {
        desde: customDesde ? startOfDay(new Date(customDesde)).toISOString() : startOfDay(now).toISOString(),
        hasta: customHasta ? endOfDay(new Date(customHasta)).toISOString() : endOfDay(now).toISOString(),
      };
  }
}

export async function getVentasPorCanal(localId: number, desde: string, hasta: string): Promise<{ data: VentasPorCanal[]; error: string | null }> {
  const { data, error } = await db.rpc('fn_reporte_ventas_por_canal_comanda', {
    p_local_id: localId, p_desde: desde, p_hasta: hasta,
  });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentasPorCanal[], error: null };
}

export async function getTopProductos(localId: number, desde: string, hasta: string, limit = 20): Promise<{ data: TopProducto[]; error: string | null }> {
  const { data, error } = await db.rpc('fn_reporte_top_productos_comanda', {
    p_local_id: localId, p_desde: desde, p_hasta: hasta, p_limit: limit,
  });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as TopProducto[], error: null };
}

export async function getTiempos(localId: number, desde: string, hasta: string): Promise<{ data: TiemposReporte | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_reporte_tiempos_comanda', {
    p_local_id: localId, p_desde: desde, p_hasta: hasta,
  });
  if (error) return { data: null, error: error.message };
  const arr = data as TiemposReporte[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

export async function getKpisPeriodo(localId: number, desde: string, hasta: string): Promise<{ data: KpisPeriodo | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_reporte_kpis_periodo_comanda', {
    p_local_id: localId, p_desde: desde, p_hasta: hasta,
  });
  if (error) return { data: null, error: error.message };
  const arr = data as KpisPeriodo[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

// CSV puro en cliente. Sin librería: Blob + URL.createObjectURL.
export function downloadCSV(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const escape = (v: string | number | null | undefined): string => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const csv = [headers.join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
