// offline2 — puente entre el mundo de las pantallas (id NUMÉRICO) y el motor
// local (identidad por `idempotency_uuid`).
//
// Las pantallas rutean por `/pos/venta/:ventaId` y chequean `id < 0` para saber
// si una venta vive solo local. offline2 usa el uuid como PK. Necesitamos un
// número negativo estable por venta.
//
// CLAVE: el tempId se DERIVA del uuid (hash determinístico), NO se guarda en el
// doc. Guardarlo rompería con el pull (que reemplaza el doc por la fila del
// server, que no tiene esa columna). Al ser determinístico, sobrevive recargas
// y se revierte escaneando los docs (ver bridge.resolveUuid).

/** FNV-1a 32-bit del uuid → entero negativo estable (rango -(1..2^31-1)). */
export function uuidToTempId(uuid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i++) {
    h ^= uuid.charCodeAt(i);
    // multiplicación FNV con overflow controlado a 32 bits
    h = Math.imul(h, 0x01000193);
  }
  // h es int32 (con signo) por imul; lo llevamos a 1..2^31-1 y negamos.
  const pos = (h >>> 0) % 0x7fffffff; // 0..2^31-2
  return -(pos + 1); // -(1..2^31-1), siempre negativo y != 0
}
