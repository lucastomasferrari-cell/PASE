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

// ─── Plantillas de reserva ────────────────────────────────────────────────────

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtFechaHoraES(iso: string): string {
  const d = new Date(iso);
  const hora = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  return `${DIAS_ES[d.getDay()]} ${d.getDate()} de ${MESES_ES[d.getMonth()]} a las ${hora}`;
}

function fmtHoraES(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function mensajeHayMesaWaitlist(args: {
  clienteNombre: string;
  localNombre: string;
  personas: number;
}): string {
  const p = `${args.personas} persona${args.personas === 1 ? '' : 's'}`;
  return `Hola ${args.clienteNombre}! 🎉\n¡Tenemos una mesa disponible en *${args.localNombre}* para ${p}!\n\nSi querés, podés acercarte ahora. Te esperamos hasta en unos minutos — avisanos si ya no podés venir.`;
}

export function mensajeConfirmacionReserva(args: {
  clienteNombre: string;
  localNombre: string;
  fechaHora: string;
  personas: number;
}): string {
  const fecha = fmtFechaHoraES(args.fechaHora);
  const p = `${args.personas} persona${args.personas === 1 ? '' : 's'}`;
  return `Hola ${args.clienteNombre}! ✅\n*Confirmamos tu reserva* en *${args.localNombre}* para el ${fecha} para ${p}.\n\nSi necesitás cancelar o modificar, avisanos con al menos 2hs de anticipación. ¡Te esperamos!`;
}

export function mensajeRecordatorioReserva(args: {
  clienteNombre: string;
  localNombre: string;
  fechaHora: string;
  personas: number;
}): string {
  const hora = fmtHoraES(args.fechaHora);
  const p = `${args.personas} persona${args.personas === 1 ? '' : 's'}`;
  return `Hola ${args.clienteNombre}! 👋\nTe recordamos que *hoy a las ${hora}* tenés reserva en *${args.localNombre}* para ${p}.\n\n¿Venís? ¡Te esperamos!`;
}
