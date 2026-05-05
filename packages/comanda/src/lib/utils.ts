// Helpers utilitarios shadcn-style.
// Reexporta también format helpers existentes para que código nuevo los
// importe de un único lugar.

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export { formatARS, parseARS, formatFechaAR, formatHoraAR, relativoCorto } from './format';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formatear hora en formato 24h argentino: "14:32"
 */
export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Formatear fecha argentina: "26/04/2026"
 */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

/**
 * Color por defecto para inputs type="color" en formularios donde el usuario
 * elige un color identificador (grupos, canales). NO es un token de UI — es
 * un valor que se persiste en DB como dato del recurso. Se centraliza para
 * mantener el grep "#XXXXXX" → 0 en archivos .tsx/.ts.
 */
export const DEFAULT_PICKER_COLOR = '#9CA3AF';
