// Helpers de WhatsApp click-to-chat.
//
// click-to-chat (wa.me) es gratis y NO requiere Twilio / WhatsApp Business
// API. Genera un link que, al abrirlo, lanza WhatsApp con un mensaje
// pre-armado. El dueño clickea y le pega "Enviar".
//
// Funciona en mobile (abre la app) y en desktop (abre WhatsApp Web).
//
// Limitación: NO es automático — alguien tiene que clickear. Para envío
// realmente automático se necesita Twilio o un BSP, postergado a sprint
// dedicado.

/**
 * Normaliza un teléfono al formato internacional sin "+" que necesita wa.me.
 * Asume Argentina si no tiene country code. Ejemplos:
 *   "1156781234"        → "5491156781234"  (suma 54 + 9)
 *   "54 11 5678-1234"   → "5411567812341234" (limpia y deja)
 *   "+54 9 11 5678..."  → "549..."
 *
 * Nota AR: el "9" después de "54" es el prefijo de "móvil" — sin él el
 * mensaje no llega. Si el número ya empieza con 549, se queda igual.
 * Si empieza con 54 pero NO 549, le agregamos el 9 cuando se ve que es móvil
 * (heurística: si después del 54 hay 10 dígitos, asumimos móvil).
 */
export function normalizarTelefonoAR(telefono: string | null | undefined): string | null {
  if (!telefono) return null;
  let clean = telefono.replace(/\D/g, '');
  if (clean.length === 0) return null;

  // Si arranca con 0, sacarlo (formato local viejo)
  if (clean.startsWith('0')) clean = clean.slice(1);

  // Si no tiene country code, asumir AR
  if (clean.length === 10) {
    // Probable móvil sin código pais (ej. 1156781234 = CABA cel)
    return `549${clean}`;
  }
  if (clean.length === 8) {
    // Probable fijo CABA sin código (raro, pero por las dudas)
    return `5411${clean}`;
  }
  if (clean.startsWith('54')) {
    // Ya tiene country code
    if (clean.length === 12 && !clean.startsWith('549')) {
      // 54 + 10 dígitos = mobile sin 9, agregamos
      return `549${clean.slice(2)}`;
    }
    return clean;
  }
  // Otro country code o número raro — devolver tal cual, que WhatsApp resuelva.
  return clean;
}

/**
 * Genera URL de wa.me con mensaje pre-armado.
 * @returns null si no hay teléfono válido
 */
export function whatsAppUrl(telefono: string | null | undefined, mensaje: string): string | null {
  const tel = normalizarTelefonoAR(telefono);
  if (!tel) return null;
  return `https://wa.me/${tel}?text=${encodeURIComponent(mensaje)}`;
}

// ─── Plantillas de mensajes pre-armadas ───────────────────────────────

export function mensajeRecibimosPedido(args: {
  clienteNombre: string;
  ventaNumero: number;
  localNombre: string;
}): string {
  return `Hola ${args.clienteNombre}! 👋\nSomos *${args.localNombre}*. Recibimos tu pedido #${args.ventaNumero} y ya lo estamos preparando.\n\nCualquier consulta, escribinos.`;
}

export function mensajePedidoListo(args: {
  clienteNombre: string;
  ventaNumero: number;
  tipoEntrega: 'retiro' | 'delivery';
  direccionLocal?: string;
}): string {
  if (args.tipoEntrega === 'retiro') {
    return `Hola ${args.clienteNombre}! 🍽️\nTu pedido #${args.ventaNumero} está listo para retirar${args.direccionLocal ? ` en ${args.direccionLocal}` : ''}.\nTe esperamos!`;
  }
  return `Hola ${args.clienteNombre}! 🛵\nTu pedido #${args.ventaNumero} salió y va camino a tu dirección.`;
}

export function mensajePedidoRechazado(args: {
  clienteNombre: string;
  ventaNumero: number;
  motivo?: string;
}): string {
  let msg = `Hola ${args.clienteNombre}, lamentablemente no pudimos tomar tu pedido #${args.ventaNumero}.`;
  if (args.motivo) msg += `\n\nMotivo: ${args.motivo}`;
  msg += '\n\nSi pagaste online, se devuelve automáticamente.';
  return msg;
}

export function mensajeGenericoCliente(clienteNombre: string, ventaNumero: number): string {
  return `Hola ${clienteNombre}, te escribimos por tu pedido #${ventaNumero}.`;
}
