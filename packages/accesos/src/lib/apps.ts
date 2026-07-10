// Catálogo de apps del ecosistema Cocina. Lo usa Accesos para mostrar
// la matriz "accesos por app" y se guarda en usuarios.apps_permitidas
// (migración 202606250700). Cada app del ecosistema chequea esta lista al login.
//
// `tier` define cómo se entra a la app (arquitectura de dos mundos):
//   - 'administrativa': cuenta personal (email + contraseña). PASE, Habitué,
//     Instagram bot, Accesos.
//   - 'operativa': dispositivo del local (1 login por local) + PIN por empleado.
//     COMANDA, MESA. Un administrativo igual puede entrar con su cuenta (sin PIN).
// El tier rutea cada app al lugar correcto del panel: administrativas van en la
// ficha de la persona; operativas en "POS del local". Sumar una app nueva =
// una línea acá.

export type AppKey = 'pase' | 'comanda' | 'mesa' | 'habitue' | 'instagram' | 'accesos';
export type AppTier = 'administrativa' | 'operativa';

export interface AppDef {
  key: AppKey;
  nombre: string;
  emoji: string;
  desc: string;
  paraQuien: string;
  url: string;
  tier: AppTier;
}

export const APPS: AppDef[] = [
  { key: 'pase', nombre: 'PASE', emoji: '', desc: 'Back-office: EERR, RRHH, Caja, Conciliación, Facturas.', paraQuien: 'Dueño, admin, contadora', url: 'https://pase-yndx.vercel.app', tier: 'administrativa' },
  { key: 'comanda', nombre: 'COMANDA', emoji: '', desc: 'POS: ventas, salón, KDS, tienda online.', paraQuien: 'Cajeros, mozos, cocina', url: 'https://pase-comanda.vercel.app', tier: 'operativa' },
  { key: 'mesa', nombre: 'MESA', emoji: '', desc: 'Reservas, plano del salón, comensales.', paraQuien: 'Encargados de reservas, anfitriones', url: 'https://mesa-orpin.vercel.app/admin', tier: 'operativa' },
  { key: 'habitue', nombre: 'Habitué', emoji: '', desc: 'CRM y marketing: segmentos, campañas, fidelidad.', paraQuien: 'Marketing, dueño', url: 'https://habitue-ruddy.vercel.app/admin', tier: 'administrativa' },
  { key: 'instagram', nombre: 'Instagram bot', emoji: '', desc: 'Bot de Instagram: respuestas automáticas y campañas.', paraQuien: 'Marketing, dueño', url: 'https://pase-instagram-bot.vercel.app', tier: 'administrativa' },
  { key: 'accesos', nombre: 'Accesos', emoji: '', desc: 'Gestión de personas y permisos (este panel).', paraQuien: 'Dueño', url: '', tier: 'administrativa' },
];

export const APPS_ADMIN: AppDef[] = APPS.filter((a) => a.tier === 'administrativa');
export const APPS_OPERATIVAS: AppDef[] = APPS.filter((a) => a.tier === 'operativa');

export function appDef(key: string): AppDef | null {
  return APPS.find((a) => a.key === (key as AppKey)) ?? null;
}
