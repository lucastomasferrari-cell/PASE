// WhatsApp click-to-chat (wa.me) — gratis, sin Twilio/BSP. Genera un link que
// abre WhatsApp con el mensaje pre-armado; el staff toca "Enviar". Port de
// COMANDA (packages/comanda/src/lib/whatsapp.ts).

export function normalizarTelefonoAR(telefono: string | null | undefined): string | null {
  if (!telefono) return null;
  let clean = telefono.replace(/\D/g, '');
  if (clean.length === 0) return null;
  if (clean.startsWith('0')) clean = clean.slice(1);
  if (clean.length === 10) return `549${clean}`;
  if (clean.length === 8) return `5411${clean}`;
  if (clean.startsWith('54')) {
    if (clean.length === 12 && !clean.startsWith('549')) return `549${clean.slice(2)}`;
    return clean;
  }
  return clean;
}

export function whatsAppUrl(telefono: string | null | undefined, mensaje: string): string | null {
  const tel = normalizarTelefonoAR(telefono);
  if (!tel) return null;
  return `https://wa.me/${tel}?text=${encodeURIComponent(mensaje)}`;
}

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fmtFechaHoraES(iso: string): string {
  const d = new Date(iso);
  const hora = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  return `${DIAS_ES[d.getDay()]} ${d.getDate()} de ${MESES_ES[d.getMonth()]} a las ${hora}`;
}

export function mensajeConfirmacionReserva(args: {
  clienteNombre: string; localNombre: string; fechaHora: string; personas: number;
}): string {
  const fecha = fmtFechaHoraES(args.fechaHora);
  const p = `${args.personas} persona${args.personas === 1 ? '' : 's'}`;
  return `Hola ${args.clienteNombre}! ✅\n*Confirmamos tu reserva* en *${args.localNombre}* para el ${fecha} para ${p}.\n\nSi necesitás cancelar o modificar, avisanos con al menos 2hs de anticipación. ¡Te esperamos!`;
}

export function mensajeHayMesaWaitlist(args: {
  clienteNombre: string; localNombre: string; personas: number;
}): string {
  const p = `${args.personas} persona${args.personas === 1 ? '' : 's'}`;
  return `Hola ${args.clienteNombre}! 🎉\n¡Tenemos una mesa disponible en *${args.localNombre}* para ${p}!\n\nSi querés, podés acercarte ahora. Te esperamos — avisanos si ya no podés venir.`;
}
