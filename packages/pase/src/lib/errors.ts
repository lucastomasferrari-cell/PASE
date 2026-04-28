// Mapper de códigos de error de las RPCs atómicas (20260423_rpc_pagos_atomicos.sql)
// a mensajes user-friendly en español. Fallback transparente si el código no
// está mapeado (muestra el string crudo, útil para diagnóstico).

const MAP: Record<string, string> = {
  // Monto / cuenta / local genéricos
  MONTO_INVALIDO: "El monto debe ser mayor a cero",
  CUENTA_INVALIDA: "Cuenta inválida",
  CUENTAS_IGUALES: "No se puede transferir a la misma cuenta",
  LOCAL_REQUERIDO: "Seleccioná un local",
  LOCAL_NO_AUTORIZADO: "No tenés permiso sobre este local",
  SALDO_INSUFICIENTE: "Saldo insuficiente en la cuenta seleccionada",
  CATEGORIA_REQUERIDA: "La categoría es obligatoria",
  MOTIVO_REQUERIDO: "El motivo es obligatorio",

  // Facturas
  FACTURA_NO_ENCONTRADA: "La factura no existe",
  FACTURA_YA_PAGADA: "Esta factura ya está pagada",
  FACTURA_ANULADA: "La factura está anulada",
  FACTURA_YA_ANULADA: "La factura ya estaba anulada",

  // Remitos
  REMITO_NO_ENCONTRADO: "El remito no existe",
  REMITO_YA_PAGADO: "Este remito ya está pagado",
  REMITO_ANULADO: "El remito está anulado",
  REMITO_YA_ANULADO: "El remito ya estaba anulado",

  // Movimientos
  MOVIMIENTO_NO_ENCONTRADO: "El movimiento no existe",
  MOVIMIENTO_YA_ANULADO: "El movimiento ya estaba anulado",

  // RRHH
  EMPLEADO_NO_ENCONTRADO: "El empleado no existe",
  LIQUIDACION_NO_ENCONTRADA: "No hay liquidación para esa novedad",
  LIQUIDACION_ANULADA: "La liquidación está anulada",
  LIQUIDACION_YA_PAGADA: "Esta liquidación ya está pagada",
  NOVEDAD_INVALIDA: "Novedad inválida",
  LIQ_FINAL_YA_EXISTE: "Este empleado ya tiene liquidación final registrada",
  MONTO_EXCEDE_PENDIENTE: "El monto asignado supera el pendiente",

  // Restore tenant (TASK 0.17 etapa 4)
  NO_AUTORIZADO: "Solo superadmin puede ejecutar esta operación",
  TENANT_NOT_FOUND: "El tenant no existe",
  BACKUP_INVALID: "El archivo de backup tiene un formato inválido",
  CROSS_TENANT_RESTORE_BLOCKED: "El backup pertenece a otro tenant. Restore bloqueado por seguridad",
  BACKUP_VERSION_UNSUPPORTED: "Versión del backup no soportada por el restore actual",
};

/**
 * Traduce el error string que devuelve una RPC al mensaje mostrable en UI.
 * Si no matchea ningún código conocido, devuelve el texto original
 * (fallback transparente — útil durante desarrollo para descubrir códigos
 * nuevos sin romper la UX).
 */
export function translateRpcError(err: unknown): string {
  if (err == null) return "Error desconocido";
  const raw = typeof err === "string" ? err : (err as any)?.message || String(err);
  if (!raw) return "Error desconocido";
  // Supabase/Postgres suele prefijar con "ERROR:  "; el código queda trim.
  const stripped = raw.trim().replace(/^ERROR:\s*/i, "").trim();
  // Match exacto primero. Algunas RPCs (restore_tenant) emiten "CODE: detalle"
  // con datos variables (UUIDs, nombres) detrás del código — para esas tomamos
  // el prefijo antes del primer ":".
  if (MAP[stripped]) return MAP[stripped];
  const colonIdx = stripped.indexOf(":");
  if (colonIdx > 0) {
    const code = stripped.slice(0, colonIdx).trim();
    if (MAP[code]) return MAP[code];
  }
  return raw;
}
