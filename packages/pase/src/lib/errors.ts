// Mapper de códigos de error de las RPCs atómicas (20260423_rpc_pagos_atomicos.sql)
// a mensajes user-friendly en español. Fallback transparente si el código no
// está mapeado (muestra el string crudo, útil para diagnóstico).

const MAP: Record<string, string> = {
  // Monto / cuenta / local genéricos
  MONTO_INVALIDO: "El monto debe ser mayor a cero",
  CUENTA_INVALIDA: "Cuenta inválida",
  CUENTAS_IGUALES: "No se puede transferir a la misma cuenta",
  LOCAL_REQUERIDO: "Seleccioná un local",
  // Mensaje específico (sprint 27-may): Caro reportó confusión cuando intentó
  // anular una factura de un local que no tenía asignado — el código del dueño
  // fue válido pero igual le dió "no tenés permiso" y entendió que el código
  // había fallado. El código autoriza ACCIONES en locales que ya tenés, no
  // da acceso a locales nuevos.
  LOCAL_NO_AUTORIZADO: "No tenés asignado este local. Pedile al dueño que te lo asigne (Usuarios → tu nombre → Locales). El código de autorización del dueño NO sirve para esto — solo autoriza acciones en locales que ya tenés.",
  SALDO_INSUFICIENTE: "Saldo insuficiente en la cuenta seleccionada",
  CATEGORIA_REQUERIDA: "La categoría es obligatoria",
  MOTIVO_REQUERIDO: "El motivo es obligatorio",

  // Facturas
  FACTURA_NO_ENCONTRADA: "La factura no existe",
  FACTURA_YA_PAGADA: "Esta factura ya está pagada",
  FACTURA_ANULADA: "La factura está anulada",
  FACTURA_YA_ANULADA: "La factura ya estaba anulada",
  FACTURA_MONTO_EXCEDE_PENDIENTE: "El monto a aplicar supera el saldo pendiente de la factura",
  FACTURA_TIPO_INVALIDO: "El comprobante no es una factura válida para esta operación",
  FACTURA_CROSS_TENANT: "Esa factura pertenece a otro tenant",
  FACTURAS_DE_PROVEEDORES_DISTINTOS: "Las facturas seleccionadas son de proveedores distintos",
  GASTO_NO_ENCONTRADO: "El gasto no existe",

  // Notas de Crédito
  NC_NO_ENCONTRADA: "La nota de crédito no existe",
  NC_YA_CONSUMIDA: "Esta nota de crédito ya está totalmente aplicada",
  NC_TIPO_INVALIDO: "El comprobante no es una nota de crédito",
  NC_PROVEEDOR_DISTINTO: "La nota de crédito es de un proveedor distinto al de la factura",
  NC_SALDO_INSUFICIENTE: "La nota de crédito no tiene saldo suficiente para aplicar ese monto",
  NC_ANULADA: "La nota de crédito está anulada",
  NC_CROSS_TENANT: "Esa nota de crédito pertenece a otro tenant",

  // Remitos
  REMITO_NO_ENCONTRADO: "El remito no existe",
  REMITO_YA_PAGADO: "Este remito ya está pagado",
  REMITO_ANULADO: "El remito está anulado",
  REMITO_YA_ANULADO: "El remito ya estaba anulado",
  REMITO_YA_VINCULADO: "Este remito ya está vinculado a otra factura",
  PROVEEDOR_DISTINTO: "El remito y la factura son de proveedores distintos",
  PARAMETROS_INVALIDOS: "Faltan datos requeridos para la operación",

  // Movimientos
  MOVIMIENTO_NO_ENCONTRADO: "El movimiento no existe",
  MOVIMIENTO_YA_ANULADO: "El movimiento ya estaba anulado",
  MOVIMIENTO_LIGADO_NO_EDITABLE: "Este movimiento viene de una factura, remito, sueldo o transferencia. Para cambiar el importe, editá o anulá el documento original.",

  // Ventas / cierres
  VENTA_ANULADA: "La venta está anulada",
  NO_HAY_LINEAS_VALIDAS: "No hay líneas con monto y medio válidos para cerrar",
  LINEAS_REQUERIDAS: "Hay que cargar al menos una línea de venta",
  LINEAS_REQUIRED: "Hay que cargar al menos una línea de venta",
  TURNO_REQUERIDO: "Seleccioná un turno",
  TURNO_REQUIRED: "Seleccioná un turno",
  FECHA_REQUERIDA: "Seleccioná una fecha",
  FECHA_REQUIRED: "Seleccioná una fecha",
  FECHA_INVALIDA: "La fecha es inválida",
  LOCAL_REQUIRED: "Seleccioná un local",
  LINEA_INVALIDA: "Una de las líneas no tiene monto o medio válido",

  // RRHH
  EMPLEADO_NO_ENCONTRADO: "El empleado no existe",
  SIN_CAMBIOS: "No hay cambios para aplicar",
  LIQUIDACION_NO_ENCONTRADA: "No hay liquidación para esa novedad",
  LIQUIDACION_ANULADA: "La liquidación está anulada",
  LIQUIDACION_YA_PAGADA: "Esta liquidación ya está pagada",
  NOVEDAD_INVALIDA: "Novedad inválida",
  LIQ_FINAL_YA_EXISTE: "Este empleado ya tiene liquidación final registrada",
  MONTO_EXCEDE_PENDIENTE: "El monto asignado supera el pendiente",
  JUSTIFICATIVO_NO_ENCONTRADO: "No se encontró el justificativo asociado",

  // MP multi-factura
  OVER_ASSIGNMENT: "El total asignado a las facturas supera el monto del movimiento",
  MOV_NO_ENCONTRADO: "El movimiento de MercadoPago no existe",

  // Dashboard pinned notes (marcar_tarea_completada)
  NOTA_INEXISTENTE: "La tarea no existe o ya fue eliminada",
  NOTA_OTRO_TENANT: "Esa tarea pertenece a otro tenant",
  NO_ES_TAREA: "Esta nota no es una tarea — no se puede completar",
  NO_AUTORIZADO_PARA_TAREA: "No podés completar esta tarea — está asignada a otro usuario o rol",
  NO_AUTH: "Sesión inválida — volvé a entrar",

  // Bandeja conciliadora Compras→Insumos (fn_conciliar_producto / fn_descartar_renglon)
  PRODUCTO_INVALIDO: "El nombre del producto está vacío o es inválido",
  MATERIA_PRIMA_NO_ENCONTRADA: "La materia prima no existe o es de otro local/tenant",
  RENGLON_NO_ENCONTRADO: "No se encontró el renglón de la factura",

  // Manager Override TOTP (validar_manager_override + generar_tenant_totp_secret)
  CODIGO_INVALIDO: "El código debe ser de 6 dígitos numéricos",
  CODIGO_NO_VALIDO: "Código incorrecto. Pedile al dueño un código nuevo (cambian cada 30s).",
  CODIGO_YA_USADO: "Ese código ya fue usado. Pedile al dueño el actual.",
  ACCION_REQUERIDA: "Falta especificar qué acción se está autorizando",
  TOTP_NO_INICIALIZADO: "El sistema de códigos no está inicializado. El dueño debe entrar a Ajustes → Códigos Manager.",

  // Auth / tenant
  AUTH_SIN_TENANT: "Sesión sin tenant — volvé a entrar",
  TENANT_ES_DEL_CALLER: "No podés borrar el tenant en el que estás autenticado",
  TENANT_MISMATCH: "No tenés permiso para acceder a datos de ese tenant",

  // Stock module (sprints 1-4 mayo 2026)
  STOCK_INSUFICIENTE: "No hay suficiente stock disponible para esa operación",
  STOCK_NEGATIVO: "El stock no puede ser negativo",
  CANTIDAD_INVALIDA: "La cantidad debe ser mayor a cero",
  INSUMO_NO_ENCONTRADO: "Ese insumo no existe o fue eliminado",
  MOTIVO_NO_ENCONTRADO: "El motivo de merma seleccionado no existe",
  ROBO_REQUIERE_OVERRIDE: "Para registrar robo de stock necesitás un código manager",
  OVERRIDE_INVALIDO: "El código manager es inválido o ya fue usado",
  TIPO_AJUSTE_INVALIDO: "Tipo de ajuste de stock inválido",
  MANAGER_REQUERIDO_PARA_TIPO: "Esta operación requiere autorización del manager",
  CONTEO_NO_ABIERTO: "El conteo físico no está abierto o no existe",
  CONTEO_YA_ABIERTO: "Ya hay un conteo físico abierto para este local — cerralo primero",

  // Traspasos entre locales
  LOCALES_IGUALES: "El local de origen y destino no pueden ser el mismo",
  LOCAL_ORIGEN_NO_ENCONTRADO: "El local de origen no existe",
  LOCAL_DESTINO_NO_ENCONTRADO: "El local de destino no existe",
  PERMISO_DENEGADO_ORIGEN: "No tenés permiso sobre el local de origen del traspaso",
  PERMISO_DENEGADO_DESTINO: "No tenés permiso sobre el local de destino del traspaso",
  TRANSFERENCIA_NO_ENCONTRADA: "Ese traspaso no existe",
  TRANSFERENCIA_NO_PENDIENTE: "Ese traspaso ya fue procesado",

  // Subscriptions / Billing (admin-console)
  SOLO_SUPERADMIN: "Solo el dueño del ecosistema puede realizar esta operación",
  INVOICE_NO_ENCONTRADA: "Esa factura del SaaS no existe",
  INVOICE_YA_PAGADA: "Esa factura ya está marcada como pagada",
  SUB_NO_ENCONTRADA: "Esa suscripción no existe",
  PLAN_GRATUITO_NO_GENERA_INVOICE: "El plan gratuito no requiere facturación",

  // Idempotency offline (COMANDA)
  IDEMPOTENCY_UUID_REUSE: "Operación rechazada — el cliente está reusando un identificador para una acción distinta",
  ITEM_NO_SINCRONIZADO: "El item todavía no sincronizó con el server. Reintentá en unos segundos.",
  ITEM_REFERENCIA_FALTANTE: "Falta referencia al item",

  // Fidelidad / puntos
  PUNTOS_INVALIDOS: "La cantidad de puntos debe ser mayor a cero",
  PUNTOS_INSUFICIENTES: "El cliente no tiene suficientes puntos para canjear",
  CLIENTE_NO_ENCONTRADO: "Cliente no encontrado",
  FIDELIDAD_NO_CONFIGURADA: "Configurá la equivalencia pesos/punto antes de canjear",
  VENTA_NO_ENCONTRADA: "La venta no existe",
  PERMISO_DENEGADO: "No tenés permiso para esta operación en este local",

  // Permission denied genérico
  forbidden_role: "Solo dueño/admin/superadmin pueden hacer esta operación",
  cannot_create_role_higher_or_equal: "No podés crear un usuario con rol superior o igual al tuyo",
  cannot_change_password_of_higher_role: "No podés cambiar la contraseña de alguien con rol superior al tuyo",
  cross_tenant_password_change_denied: "Solo el superadmin puede cambiar contraseñas de otros tenants",
  target_user_not_found: "El usuario a modificar no existe",

  // Genérico: cualquier RPC que tire NO_AUTORIZADO sin sufijo. Las RPCs
  // de gastos/movimientos/etc tiran "NO_AUTORIZADO: requiere permiso XXX"
  // — el sufijo después del ":" se agrega al final del mensaje (ver
  // translateRpcError abajo).
  NO_AUTORIZADO: "No tenés permiso para esta operación. Pedí acceso al dueño.",
  TENANT_NOT_FOUND: "El tenant no existe",
  NO_PUEDE_GRANTEAR_PERMISO_USUARIOS: "Solo dueño o admin puede otorgar el permiso 'Usuarios'. Los demás permisos sí podés gestionarlos.",
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
  // err puede ser PostgrestError (de supabase) o Error nativo, ambos con .message.
  // Otras shapes (objetos custom) caen al String(err) fallback.
  const raw = typeof err === "string"
    ? err
    : (err as { message?: string })?.message || String(err);
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
    const suffix = stripped.slice(colonIdx + 1).trim();
    if (MAP[code]) {
      // El sufijo del RAISE (ej: "requiere permiso compras_anular",
      // "cross-tenant") da contexto útil para diagnosticar. Lo anexamos
      // entre paréntesis al mensaje traducido.
      return suffix ? `${MAP[code]} (${suffix})` : MAP[code];
    }
  }
  return raw;
}
