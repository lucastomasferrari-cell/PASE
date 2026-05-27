import { Component, type ErrorInfo, type ReactNode } from "react";
import { tryReloadOnChunkError, isChunkLoadError } from "../lib/chunkLoadErrorHandler";
import { db } from "../lib/supabase";
import { getConsoleErrors } from "../lib/consoleCapture";

/**
 * ErrorBoundary global — captura crashes de React y muestra una pantalla
 * con identidad de marca en vez de "pantalla en blanco" o el HTML default.
 *
 * Diseñado 2026-05-17 para reemplazar el comportamiento default (que
 * confundía al user: "se rompió la app entera, no sé qué hacer").
 *
 * Características:
 *   - Logo PASE centrado + mensaje amable
 *   - Detalle técnico colapsable (toggle "Ver detalle técnico")
 *   - Botón "Recargar la app" que hace window.location.reload()
 *   - Botón "Limpiar sesión y entrar de nuevo" que limpia sessionStorage
 *   - Mailto opcional para reportar el error
 *
 * No reseteamos el state interno automáticamente — es preferible que el user
 * recargue manualmente, así no entra en loop si el error es persistente.
 */

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetalle: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    showDetalle: false,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Logging en consola — Vercel + Sentry futuro pueden engancharse acá.
    console.error("[ErrorBoundary] React crash:", error);
    console.error("[ErrorBoundary] Component stack:", errorInfo.componentStack);
    this.setState({ errorInfo });

    // AUDIT F4C#9: persistir el error en DB via RPC fn_log_frontend_error
    // para que Lucas pueda verlo desde admin-console (antes solo vivía en
    // DevTools del browser del user → invisible).
    // No-blocking: si la llamada falla, no nos preocupamos (el user ya está
    // viendo la pantalla de error igual). Best effort.
    // PostgrestFilterBuilder retorna thenable pero no Promise nativa;
    // envolvemos en async IIFE para tener .catch real.
    (async () => {
      try {
        await db.rpc('fn_log_frontend_error', {
          p_message: error.message || 'unknown',
          p_stack: error.stack || null,
          p_url: typeof window !== 'undefined' ? window.location.href : null,
          p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          p_context: {
            component_stack: errorInfo.componentStack,
            recent_console_errors: getConsoleErrors().slice(-10),
          },
        });
      } catch { /* ignore — no bloquear pantalla de error */ }
    })();

    // Si es "Failed to fetch dynamically imported module" (típico después
    // de un deploy nuevo de Vercel), intentamos auto-reload. La función
    // tiene cooldown anti-loop: solo recarga 1 vez por minuto. Si recargó,
    // el user ni ve esta pantalla.
    tryReloadOnChunkError(error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const errMsg = this.state.error?.message || "Error desconocido";
    const stack = this.state.error?.stack || "";
    const componentStack = this.state.errorInfo?.componentStack || "";
    // Mensaje específico si es chunk load error post-deploy (la caída más
    // común). Aclara al user qué hacer y por qué pasó.
    const esChunkError = isChunkLoadError(this.state.error);
    const mensajeUser = esChunkError
      ? "Hubo una actualización nueva del sistema mientras estabas adentro. Recargá la página para usar la versión actualizada."
      : "Tu data está segura. Probá recargar primero. Si el error sigue, limpiá la sesión y volvé a entrar.";

    return (
      <div style={{
        position: "fixed", inset: 0,
        background: "var(--pase-bg, #0E1726)",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: 12, padding: 24,
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#F0F4F8",
        textAlign: "center",
      }}>
        <div style={{
          fontSize: 38, fontWeight: 500,
          letterSpacing: "-0.035em", lineHeight: 1,
        }}>
          pase<span style={{ color: "#F5C518" }}>.</span>
        </div>
        <div style={{
          fontSize: 14, color: "#93A8C2", marginBottom: 8,
        }}>
          algo se rompió
        </div>

        <div style={{
          maxWidth: 500, padding: "16px 20px",
          background: "rgba(220, 38, 38, 0.12)",
          border: "0.5px solid rgba(220, 38, 38, 0.35)",
          borderRadius: 10,
          fontSize: 13, color: "#FCA5A5",
          textAlign: "left", lineHeight: 1.5,
        }}>
          <strong>{esChunkError ? "Versión desactualizada" : errMsg}</strong>
          <br />
          <span style={{ color: "#93A8C2", fontSize: 12 }}>
            {mensajeUser}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 18px",
              background: "#75AADB", color: "#FFF",
              border: "none", borderRadius: 8,
              fontSize: 13, fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Recargar la app
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                sessionStorage.clear();
                localStorage.removeItem("pase_local_activo");
              } catch { /* ignore */ }
              window.location.href = "/";
            }}
            style={{
              padding: "10px 18px",
              background: "transparent", color: "#F0F4F8",
              border: "0.5px solid #3F4D6E", borderRadius: 8,
              fontSize: 13, fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Limpiar sesión
          </button>
        </div>

        <button
          type="button"
          onClick={() => this.setState(s => ({ showDetalle: !s.showDetalle }))}
          style={{
            marginTop: 12,
            background: "transparent", border: "none",
            color: "#93A8C2", fontSize: 12,
            cursor: "pointer", fontFamily: "inherit",
            textDecoration: "underline",
          }}
        >
          {this.state.showDetalle ? "Ocultar detalle técnico" : "Ver detalle técnico"}
        </button>

        {this.state.showDetalle && (
          <pre style={{
            marginTop: 8, padding: 12,
            background: "rgba(0, 0, 0, 0.3)",
            border: "0.5px solid #2A3550",
            borderRadius: 8,
            maxWidth: 700, maxHeight: 240,
            overflow: "auto",
            fontSize: 10, lineHeight: 1.4,
            textAlign: "left",
            color: "#93A8C2",
            fontFamily: "monospace",
          }}>
{stack}
{componentStack && `\n\nComponent stack:${componentStack}`}
          </pre>
        )}
      </div>
    );
  }
}
