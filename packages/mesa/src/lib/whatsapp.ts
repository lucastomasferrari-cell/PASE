// WhatsApp helper: si el tenant tiene WA Business API configurada (hub de
// credenciales en COMANDA Settings → Integraciones), manda el mensaje
// automáticamente sin abrir nada. Si NO, cae a wa.me (click-to-chat) — gratis.
// Port + extensión de COMANDA (packages/comanda/src/lib/whatsapp.ts).

import { db } from './supabase';

const PASE_API_BASE = (import.meta.env.VITE_PASE_API_BASE as string | undefined) || 'https://pase-yndx.vercel.app';

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

function fmtHoraES(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function mensajeRecordatorioReserva(args: {
  clienteNombre: string; localNombre: string; fechaHora: string; personas: number;
}): string {
  const hora = fmtHoraES(args.fechaHora);
  const p = `${args.personas} persona${args.personas === 1 ? '' : 's'}`;
  return `Hola ${args.clienteNombre}! 👋\nTe recordamos que *hoy a las ${hora}* tenés reserva en *${args.localNombre}* para ${p}.\n\n¿Venís? ¡Te esperamos!`;
}

/**
 * Manda un mensaje de WhatsApp. Si el tenant tiene WA Business API configurada,
 * lo envía automáticamente (silent). Si no, devuelve la URL wa.me para que el
 * llamador la abra (fallback manual).
 *
 * @returns { sent: true } si se envió automático
 *          { sent: false, fallbackUrl } si hay que abrir wa.me a mano
 */
const WA_SEND_TIMEOUT_MS = 5000; // fix audit 26-jun ALTO-8

export async function enviarOFallback(
  telefono: string | null | undefined,
  mensaje: string,
  opts: { timeoutMs?: number } = {},
): Promise<{
  sent: boolean;
  fallbackUrl?: string;
  error?: string;
}> {
  const tel = normalizarTelefonoAR(telefono);
  if (!tel) return { sent: false, error: 'sin_telefono' };

  const timeoutMs = opts.timeoutMs ?? WA_SEND_TIMEOUT_MS;

  // 1. Intentar via WA Business API (endpoint /api/auth-admin?action=wa-send).
  //    Fix audit ALTO-8: timeout con AbortController. Sin esto, si el endpoint
  //    colgaba, el llamador (handler de Confirmar reserva) esperaba el default
  //    del browser (~30s) con la UI bloqueada y popup en blanco.
  try {
    const { data: sess } = await db().auth.getSession();
    const token = sess.session?.access_token;
    if (token) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${PASE_API_BASE}/api/auth-admin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'wa-send', to: tel, texto: mensaje }),
          signal: ctrl.signal,
        });
        const d = await r.json();
        if (d.ok) return { sent: true };
        // Si la credencial no está configurada, caemos al fallback wa.me
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // network error / abort → fallback
  }

  // 2. Fallback: link wa.me que el staff toca para enviar manual.
  return { sent: false, fallbackUrl: `https://wa.me/${tel}?text=${encodeURIComponent(mensaje)}` };
}
