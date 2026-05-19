import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Concatena clases Tailwind con merge inteligente (dedupea conflictos). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
