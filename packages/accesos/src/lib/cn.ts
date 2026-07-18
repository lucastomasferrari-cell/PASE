// Helper de clases condicionales. Vive fuera de primitives.tsx para que ese
// archivo exporte solo componentes (react-refresh/only-export-components).
export function cn(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}
