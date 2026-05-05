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
