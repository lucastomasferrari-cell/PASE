// campanasService — helpers de campañas (WhatsApp click-to-chat + email).
// Sin API: genera links wa.me por cliente y mailto BCC. La automatización real
// (envío masivo) se enchufa cuando esté la WhatsApp Business API / proveedor de
// email. Plantillas con {nombre} que se reemplaza por cliente.

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

export interface Plantilla {
  key: string;
  label: string;
  sugerencias: string[];   // para qué segmentos se sugiere
  texto: string;           // con {nombre}
}

export const PLANTILLAS: Plantilla[] = [
  { key: 'reactivar', label: 'Te extrañamos', sugerencias: ['reactivar'],
    texto: 'Hola {nombre}! 👋 Hace un tiempo que no te vemos y te queremos de vuelta. Te dejamos un descuento especial para tu próxima visita. ¿Te esperamos? 🍽️' },
  { key: 'segunda_compra', label: 'Comprá de nuevo', sugerencias: ['segunda_compra'],
    texto: 'Hola {nombre}! Gracias por tu primera visita 🙌 Para que vuelvas, te regalamos un beneficio en tu próximo pedido. ¡Te esperamos!' },
  { key: 'bienvenida', label: 'Bienvenida', sugerencias: ['bienvenida'],
    texto: 'Hola {nombre}! Gracias por elegirnos 🎉 Si te gustó, contanos y volvé cuando quieras — siempre tenemos algo rico para vos.' },
  { key: 'fidelizar', label: 'Gracias / fidelización', sugerencias: ['fidelizar'],
    texto: 'Hola {nombre}! Sos de los que más nos elige y eso lo valoramos un montón 💛 Tenemos un mimo reservado para vos en tu próxima visita.' },
  { key: 'promo', label: 'Promo / novedad', sugerencias: ['promo'],
    texto: 'Hola {nombre}! Tenemos una promo nueva que te puede gustar 😍 Pasá a probarla o pedila online. ¡Te esperamos!' },
];

export function plantillasPara(sugerencia: string): Plantilla[] {
  const match = PLANTILLAS.filter((p) => p.sugerencias.includes(sugerencia));
  return match.length ? match : PLANTILLAS;
}

export function aplicarPlantilla(texto: string, nombre: string | null): string {
  const primer = (nombre ?? '').trim().split(' ')[0] || 'hola';
  return texto.replace(/\{nombre\}/g, primer);
}
