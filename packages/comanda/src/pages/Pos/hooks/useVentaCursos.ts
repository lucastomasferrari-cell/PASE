import { useMemo } from 'react';
import type { VentaPosItem } from '../../../types/database';
import type { ItemConGrupo } from '../../../services/itemsService';

export interface UseVentaCursosResult {
  itemsPorCurso: Map<number, VentaPosItem[]>;
  tiempoEstimadoMin: number;
  holdCount: (curso: number) => number;
  stayCount: (curso: number) => number;
}

export function useVentaCursos(
  items: VentaPosItem[],
  catalogo: ItemConGrupo[],
): UseVentaCursosResult {
  // Items agrupados por curso, ordenados por número de curso
  const itemsPorCurso = useMemo(() => {
    const map = new Map<number, VentaPosItem[]>();
    for (const it of items) {
      const c = it.curso ?? 1;
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(it);
    }
    return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
  }, [items]);

  // Tiempo estimado de la mesa: del catálogo, sumar tiempo_prep_min de cada
  // item en hold/enviada. Por curso tomamos el MAX (cocina trabaja paralelo
  // dentro de un curso) y sumamos cursos (cursos son seriales).
  const tiempoEstimadoMin = useMemo(() => {
    if (items.length === 0) return 0;
    const porCurso = new Map<number, number>();
    for (const it of items) {
      if (it.estado === 'anulado' || it.estado === 'listo' || it.estado === 'entregado') continue;
      const cat = catalogo.find((c) => c.id === it.item_id);
      const prep = cat?.tiempo_prep_min ?? 0;
      const c = it.curso ?? 1;
      porCurso.set(c, Math.max(porCurso.get(c) ?? 0, prep));
    }
    return Array.from(porCurso.values()).reduce((s, v) => s + v, 0);
  }, [items, catalogo]);

  // Hold count por curso — items que SÍ se enviarían (no en stay)
  function holdCount(curso: number): number {
    return (itemsPorCurso.get(curso) ?? []).filter((i) => i.estado === 'hold' && !i.stay_until_release).length;
  }

  // Stay count por curso — items en hold permanente
  function stayCount(curso: number): number {
    return (itemsPorCurso.get(curso) ?? []).filter((i) => i.estado === 'hold' && i.stay_until_release).length;
  }

  return { itemsPorCurso, tiempoEstimadoMin, holdCount, stayCount };
}
