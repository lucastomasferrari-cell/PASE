// Helpers puros (sin I/O, sin TZ) para la lógica de reservas: rango y
// posicionamiento del timeline del Diario, y buckets de turno. Aislados acá
// para poder testearlos de forma determinística.

export interface ItemTimeline { startMin: number; durMin: number; }

/**
 * Rango horario del timeline: arranca en defIni (o antes si hay items más
 * temprano) y termina en defFin (o después si alguno termina más tarde).
 * Devuelve los minutos de inicio/fin (múltiplos de 60) y las marcas de hora.
 */
export function calcularRango(items: ItemTimeline[], defIni = 12 * 60, defFin = 24 * 60): {
  rangoIni: number; rangoFin: number; horas: number[];
} {
  let ini = defIni, fin = defFin;
  for (const it of items) {
    ini = Math.min(ini, Math.floor(it.startMin / 60) * 60);
    fin = Math.max(fin, Math.ceil((it.startMin + it.durMin) / 60) * 60);
  }
  ini = Math.max(0, ini);
  fin = Math.min(30 * 60, fin);
  if (fin < ini) fin = ini;
  const horas: number[] = [];
  for (let h = ini; h <= fin; h += 60) horas.push(h);
  return { rangoIni: ini, rangoFin: fin, horas };
}

/** Posición (px) de un bloque en el timeline dado el rango y el ancho por minuto. */
export function bloqueTimeline(startMin: number, durMin: number, rangoIni: number, pxPerMin: number, minWidth = 38): {
  left: number; width: number;
} {
  return {
    left: (startMin - rangoIni) * pxPerMin,
    width: Math.max(minWidth, durMin * pxPerMin - 2),
  };
}

/** ¿El minuto del día cae dentro de [ini, fin)? (para buckets de turno) */
export function dentroDeTurno(min: number, ini: number, fin: number): boolean {
  return min >= ini && min < fin;
}
