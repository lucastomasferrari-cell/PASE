// Tests del chunkLoadErrorHandler — auto-reload cuando un import dinámico
// falla porque el chunk del build viejo ya no existe en Vercel (post-deploy).
//
// Bug Lucas 2026-06-11: "Abrir mesa" colgado en "Abriendo..." con
// "Uncaught (in promise) TypeError: Failed to fetch dynamically imported
// module: ventasOfflineService-Cf9qKHwB.js". El ErrorBoundary NO lo atrapó
// porque el import falló en un click handler (async), no en el render.
// Por eso hacen falta listeners globales a unhandledrejection/error.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isChunkLoadError,
  tryReloadOnChunkError,
  installChunkLoadErrorHandler,
} from './chunkLoadErrorHandler';

const reloadMock = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  reloadMock.mockClear();
  // jsdom no implementa location.reload — lo reemplazamos por un mock.
  Object.defineProperty(window, 'location', {
    value: { reload: reloadMock },
    writable: true,
  });
});

describe('isChunkLoadError', () => {
  it('detecta el error de Chrome/Edge (caso del bug 11-jun)', () => {
    expect(
      isChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://pase-comanda.vercel.app/assets/ventasOfflineService-Cf9qKHwB.js',
        ),
      ),
    ).toBe(true);
  });

  it('detecta variantes de Firefox y Safari', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('detecta ChunkLoadError por name y "Loading chunk N failed"', () => {
    const e = new Error('algo');
    e.name = 'ChunkLoadError';
    expect(isChunkLoadError(e)).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 42 failed'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 7 failed'))).toBe(true);
  });

  it('NO matchea errores genéricos ni null', () => {
    expect(isChunkLoadError(new Error('SALDO_INSUFICIENTE'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('tryReloadOnChunkError', () => {
  const chunkError = new TypeError('Failed to fetch dynamically imported module: x.js');

  it('recarga la página ante chunk error y devuelve true', () => {
    expect(tryReloadOnChunkError(chunkError)).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('anti-loop: NO recarga dos veces dentro del cooldown', () => {
    expect(tryReloadOnChunkError(chunkError)).toBe(true);
    expect(tryReloadOnChunkError(chunkError)).toBe(false);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('no hace nada con errores que no son de chunk', () => {
    expect(tryReloadOnChunkError(new Error('otra cosa'))).toBe(false);
    expect(reloadMock).not.toHaveBeenCalled();
  });
});

describe('installChunkLoadErrorHandler', () => {
  it('recarga ante unhandledrejection con chunk error (el caso del POS colgado)', () => {
    installChunkLoadErrorHandler();
    // jsdom no tiene PromiseRejectionEvent — simulamos con Event + reason.
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = new TypeError(
      'Failed to fetch dynamically imported module: https://pase-comanda.vercel.app/assets/ventasOfflineService-Cf9qKHwB.js',
    );
    window.dispatchEvent(event);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('recarga ante window error event con chunk error', () => {
    installChunkLoadErrorHandler();
    const event = new ErrorEvent('error', {
      error: new Error('Importing a module script failed.'),
    });
    window.dispatchEvent(event);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('ignora rejections que no son de chunk', () => {
    installChunkLoadErrorHandler();
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = new Error('FACTURA_YA_PAGADA');
    window.dispatchEvent(event);
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
