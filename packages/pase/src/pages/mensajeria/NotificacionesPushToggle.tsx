// Botón para activar/desactivar notificaciones push de DMs IG en el celu.
// Sin restricciones de rol (Lucas 22-may noche): si el user llegó a la
// pantalla de Mensajería, ya pasó el gate de permiso `mensajeria` →
// puede suscribirse. El bot IG invoca webpush cuando llega un DM al
// tenant del user.

import { useEffect, useState, useCallback } from "react";
import { getPushPermissionStatus, isCurrentlySubscribed, subscribeToPush, unsubscribeFromPush } from "../../lib/push";

export function NotificacionesPushToggle() {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setSubscribed(await isCurrentlySubscribed());
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const perm = getPushPermissionStatus();
  if (perm === "unsupported") {
    return (
      <div style={{
        fontSize: 11, color: "var(--muted2)", padding: "8px 12px",
        background: "var(--s2)", border: "0.5px solid var(--bd)", borderRadius: 6,
      }}>
        ℹ️ Tu navegador no soporta notificaciones push. Probá Chrome/Firefox/Edge.
      </div>
    );
  }

  const onToggle = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (subscribed) {
        const r = await unsubscribeFromPush();
        if (r.ok) {
          setMsg({ kind: "ok", text: "Notificaciones desactivadas en este dispositivo" });
        } else {
          setMsg({ kind: "err", text: r.error || "Error desactivando" });
        }
      } else {
        const r = await subscribeToPush();
        if (r.ok) {
          setMsg({ kind: "ok", text: "🔔 Notificaciones activadas. Te llegarán los nuevos DMs aunque PASE esté cerrado." });
        } else {
          setMsg({ kind: "err", text: r.error || "Error activando" });
        }
      }
      await refresh();
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 6000);
    }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "10px 14px", background: "var(--s2)", border: "0.5px solid var(--bd)",
      borderRadius: 8, marginBottom: 12, fontSize: 12,
    }}>
      <span style={{ fontWeight: 500 }}>
        {subscribed === null ? "Verificando..."
          : subscribed ? "🔔 Notificaciones activas en este dispositivo"
          : "🔕 Notificaciones desactivadas"}
      </span>
      <button
        className={subscribed ? "btn btn-ghost btn-sm" : "btn btn-acc btn-sm"}
        onClick={onToggle}
        disabled={busy || perm === "denied"}
      >
        {busy ? "..." : (subscribed ? "Desactivar" : "Activar")}
      </button>
      {perm === "denied" && (
        <span style={{ fontSize: 10, color: "var(--warn)" }}>
          Permisos bloqueados — habilitar en Configuración del navegador
        </span>
      )}
      {msg && (
        <span style={{
          fontSize: 11,
          color: msg.kind === "ok" ? "var(--success)" : msg.kind === "err" ? "var(--danger)" : "var(--muted2)",
          fontWeight: 500,
        }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
