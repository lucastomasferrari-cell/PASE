// Catálogo de tipos de notificación.
//
// Cada user puede activar/desactivar c/u desde /configuracion/notificaciones.
// El default es ON (opt-out). Si el user no tocó la pantalla, recibe todo.
//
// Cuando agregues un tipo nuevo:
//   1. Sumar entrada acá (id + label + descripción + emoji).
//   2. En el emisor (bot, cron, RPC), antes de mandar el push:
//      const { data: ok } = await db.rpc('fn_user_quiere_notif', {
//        p_user_id: userId, p_type: 'tu_tipo_nuevo'
//      });
//      if (!ok) return;
//   3. Si tenés función helper en `packages/instagram-bot/api/_lib/push.js`
//      o equivalente, pasale el `notification_type` para filtrar por user.

export type NotificationTypeId =
  | "ig_dm_new"
  | "marketplace_order_new"
  | "ig_escalation_human"
  | "cashbox_negative"
  | "daily_closing_summary"
  | "stock_posible_fuga";

export interface NotificationTypeMeta {
  id: NotificationTypeId;
  label: string;
  emoji: string;
  description: string;
  /**
   * "Implementada" = el emisor ya respeta la preferencia y manda push si está ON.
   * "Próximamente" = todavía no hay emisor wireado (default ON pero nunca llega).
   * Se muestra como pill en la UI para que Lucas sepa qué está vivo.
   */
  status: "implementada" | "proximamente";
  /**
   * Grupo visual en la pantalla de configuración.
   */
  group: "instagram" | "tienda_online" | "operacion";
}

export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  {
    id: "ig_dm_new",
    label: "DM nuevo en Instagram",
    emoji: "📩",
    description: "Cuando un cliente manda un mensaje directo al Instagram del local. Con cooldown de 5 minutos para no spamear si manda 10 mensajes seguidos.",
    status: "implementada",
    group: "instagram",
  },
  {
    id: "ig_escalation_human",
    label: "Cliente IG pidió hablar con humano",
    emoji: "🙋",
    description: "Cuando el bot detecta que el cliente quiere hablar con una persona real (ej. pide reclamo, queja, o consulta compleja que el bot no resuelve).",
    status: "proximamente",
    group: "instagram",
  },
  {
    id: "marketplace_order_new",
    label: "Pedido nuevo en tienda online",
    emoji: "🛒",
    description: "Cuando un cliente confirma un pedido desde la tienda pública o el marketplace.",
    status: "proximamente",
    group: "tienda_online",
  },
  {
    id: "cashbox_negative",
    label: "Saldo de caja física negativo",
    emoji: "⚠️",
    description: "Si al cerrar el día alguna cuenta de caja física (Efectivo, Banco, MP) queda con saldo negativo — indica un movimiento sin justificar o un descuadre.",
    status: "proximamente",
    group: "operacion",
  },
  {
    id: "daily_closing_summary",
    label: "Resumen del cierre del día",
    emoji: "📊",
    description: "Una vez por día, después del cierre de turno noche: total ventas, total gastos, neto del día y top 3 productos.",
    status: "proximamente",
    group: "operacion",
  },
  {
    id: "stock_posible_fuga",
    label: "Posible fuga detectada en conteo",
    emoji: "🚨",
    description: "Cuando un conteo físico termina con pérdida >$5.000 sin justificar (no es merma declarada). El bot manda push al celu con detalle: monto perdido, local y posibles causas.",
    status: "implementada",
    group: "operacion",
  },
];

export const NOTIFICATION_GROUPS: { id: NotificationTypeMeta["group"]; label: string; icon: string }[] = [
  { id: "instagram",     label: "Instagram",       icon: "📷" },
  { id: "tienda_online", label: "Tienda online",   icon: "🛒" },
  { id: "operacion",     label: "Operación diaria", icon: "🏪" },
];

export function getNotificationType(id: string): NotificationTypeMeta | undefined {
  return NOTIFICATION_TYPES.find(t => t.id === id);
}
