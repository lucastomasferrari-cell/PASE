// consoleCapture.ts — captura los últimos N errores de consola del browser
// para incluirlos automáticamente en los tickets de soporte.
//
// Patrón: array circular en memoria (sessionStorage es muy chico para errores
// largos con stack traces, y se pierde al cerrar pestaña — pero los errores
// del último minuto antes del reporte son los importantes y están en memoria).
//
// Capturamos:
//   - console.error (incluye errores manuales de la app)
//   - window.onerror (uncaught exceptions sincrónicas)
//   - unhandledrejection (promises rejected sin .catch)
//
// Helper público: getConsoleErrors() lo lee el SoporteWidget al armar el ticket.
//
// Init: importar y llamar initConsoleCapture() una vez en App.tsx.

const MAX_ERRORS = 20;
const errors: CapturedError[] = [];

export interface CapturedError {
  ts: string;
  type: 'console.error' | 'window.error' | 'unhandledrejection';
  message: string;
  stack?: string;
  source?: string;
  lineno?: number;
}

let initialized = false;

export function initConsoleCapture(): void {
  if (initialized) return;
  initialized = true;

  const origError = console.error;
  console.error = (...args: unknown[]) => {
    try {
      const message = args
        .map((a) => {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          if (a instanceof Error) return `${a.name}: ${a.message}`;
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(' ');
      const stack = args.find((a) => a instanceof Error)?.stack;
      pushError({
        ts: new Date().toISOString(),
        type: 'console.error',
        message: message.slice(0, 2000),
        stack: typeof stack === 'string' ? stack.slice(0, 2000) : undefined,
      });
    } catch {
      // No queremos romper console.error si el captura falla
    }
    origError.apply(console, args);
  };

  window.addEventListener('error', (e: ErrorEvent) => {
    pushError({
      ts: new Date().toISOString(),
      type: 'window.error',
      message: e.message?.slice(0, 2000) || '(no message)',
      source: e.filename,
      lineno: e.lineno,
      stack: e.error?.stack?.slice(0, 2000),
    });
  });

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    let msg: string;
    const reason: unknown = e.reason;
    if (reason instanceof Error) {
      msg = `${reason.name}: ${reason.message}`;
    } else if (typeof reason === 'string') {
      msg = reason;
    } else {
      try { msg = JSON.stringify(reason); } catch { msg = String(reason); }
    }
    pushError({
      ts: new Date().toISOString(),
      type: 'unhandledrejection',
      message: msg.slice(0, 2000),
      stack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
    });
  });
}

function pushError(err: CapturedError) {
  errors.push(err);
  if (errors.length > MAX_ERRORS) errors.shift();
}

export function getConsoleErrors(): CapturedError[] {
  return [...errors];
}

export function clearConsoleErrors(): void {
  errors.length = 0;
}
