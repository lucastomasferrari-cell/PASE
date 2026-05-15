// Traduce errores RPC del backend a mensajes legibles para el usuario.
// Convención: las RPC lanzan EXCEPTION 'CODIGO_UPPER_SNAKE'.
//
// Sin esto, el frontend muestra al cajero literalmente "ERROR: ITEM_NO_DISPONIBLE"
// (mensaje crudo de Postgres). Mantener este mapping al día — cada RPC nueva
// que lance un código tiene que sumar su traducción acá.

const TRADUCCIONES: Record<string, string> = {
  // ── Permisos ──────────────────────────────────────────────────────────
  SIN_PERMISO_AUMENTO_MASIVO: 'No tenés permiso para aplicar aumento masivo.',
  SIN_PERMISO_MARCAR_AGOTADO: 'No tenés permiso para marcar items como agotados.',
  SIN_PERMISO_MARCAR_DISPONIBLE: 'No tenés permiso para reactivar items.',
  SIN_PERMISO_VENTAS: 'No tenés permiso para operar ventas.',
  SIN_PERMISO_DESCUENTO: 'No tenés permiso para aplicar descuentos.',
  SIN_PERMISO_APROBAR: 'No tenés permiso para aprobar pedidos.',
  SIN_PERMISO_CAJA_ABRIR: 'No tenés permiso para abrir caja.',
  SIN_PERMISO_CAJA_CERRAR: 'No tenés permiso para cerrar caja.',
  SIN_PERMISO_CAJA_MOVIMIENTOS: 'No tenés permiso para registrar movimientos de caja.',
  SIN_PERMISO_REPORTES: 'No tenés permiso para ver reportes.',
  SIN_PERMISO_EDITAR_PIN: 'No tenés permiso para editar PINs.',
  NO_AUTORIZADO: 'No estás autorizado para esta acción.',

  // ── Auth / multi-tenant / IDOR ───────────────────────────────────────
  LOCAL_NO_AUTORIZADO: 'Ese local no está autorizado para tu sesión.',
  LOCAL_NO_VISIBLE: 'Ese local no está entre tus locales asignados.',
  LOCAL_NO_ENCONTRADO: 'El local no existe.',
  EMPLEADO_NO_ENCONTRADO: 'El empleado no existe.',
  EMPLEADO_NO_EN_LOCAL: 'El empleado no pertenece a este local.',
  EMPLEADO_NO_PERTENECE_A_LOCAL: 'El empleado no pertenece a este local.',
  EMPLEADO_NO_PERTENECE_A_TENANT: 'El empleado no pertenece a este restaurante.',

  // ── Manager override ──────────────────────────────────────────────────
  MANAGER_REQUERIDO: 'Esta acción requiere autorización de un manager.',
  MANAGER_INVALIDO: 'El PIN de manager es incorrecto o no tiene permisos.',
  MANAGER_REQUERIDO_DESCUENTO_GRANDE: 'Descuento mayor al 15% requiere manager.',
  RETIRO_REQUIERE_MANAGER: 'Los retiros de caja requieren autorización de manager.',
  PIN_INVALIDO: 'El PIN es incorrecto.',
  PIN_ACTUAL_INCORRECTO: 'El PIN actual no es correcto.',

  // ── Items ────────────────────────────────────────────────────────────
  ITEM_NO_ENCONTRADO: 'El item no existe o no es accesible.',
  ITEM_NO_DISPONIBLE: 'El item está marcado como agotado.',
  ITEM_NO_EDITABLE: 'El item ya fue enviado a cocina y no se puede editar.',
  ITEM_NO_ENVIADO_O_YA_LISTO: 'El item no está en estado válido para esta acción.',
  ITEM_NO_PERTENECE_A_ESTACION: 'El item no pertenece a esta estación de cocina.',
  ITEMS_REQUERIDOS: 'Tenés que seleccionar al menos un item.',

  // ── Ventas ───────────────────────────────────────────────────────────
  VENTA_NO_ENCONTRADA: 'La venta no existe.',
  VENTA_YA_COBRADA: 'La venta ya fue cobrada.',
  VENTA_ANULADA: 'La venta fue anulada.',
  VENTA_NO_EDITABLE: 'La venta ya no se puede editar.',
  VENTA_NO_REOPEN: 'La venta no se puede reabrir desde este estado.',
  VENTAS_CROSS_LOCAL: 'Las ventas pertenecen a locales distintos.',
  VENTAS_IGUALES: 'No podés unir una venta consigo misma.',
  NO_SE_PUEDE_UNIR_VENTA_COBRADA: 'No se pueden unir ventas ya cobradas.',
  RECALL_VENTANA_60S_VENCIDA: 'Pasaron más de 60 segundos, no se puede deshacer.',

  // ── Mesas ────────────────────────────────────────────────────────────
  MESA_DESTINO_NO_ENCONTRADA: 'La mesa de destino no existe.',
  MESA_DESTINO_CROSS_LOCAL: 'La mesa de destino pertenece a otro local.',

  // ── Pagos ────────────────────────────────────────────────────────────
  SUMA_PAGOS_NO_COINCIDE: 'La suma de los pagos no coincide con el total.',
  SOBREPAGO: 'El pago supera el total adeudado.',
  MONTO_INVALIDO: 'El monto ingresado no es válido.',
  DESCUENTO_INVALIDO: 'El descuento ingresado no es válido.',
  MOTIVO_REQUERIDO: 'Tenés que indicar un motivo.',

  // ── Caja / turnos ────────────────────────────────────────────────────
  NO_HAY_TURNO_ABIERTO: 'No hay turno de caja abierto en este local.',
  TURNO_NO_ABIERTO: 'El turno no está abierto.',
  TURNO_YA_ABIERTO: 'Ya hay un turno abierto en este local.',
  TURNO_YA_CERRADO: 'Este turno ya fue cerrado.',
  TURNO_NO_ENCONTRADO: 'El turno no existe.',
  TURNO_NO_ENCONTRADO_O_CERRADO: 'El turno no existe o ya está cerrado.',
  CUENTA_INVALIDA: 'La cuenta seleccionada no es válida.',
  TIPO_INVALIDO: 'Tipo de movimiento inválido.',

  // ── Pedidos online / tienda / menú QR ────────────────────────────────
  CANAL_TIENDA_NO_CONFIGURADO: 'El canal de tienda online no está configurado.',
  CANAL_MENU_QR_NO_CONFIGURADO: 'El canal de menú QR no está configurado.',
  LOCAL_NO_ACEPTA_DELIVERY: 'Este local no acepta delivery actualmente.',
  TIPO_ENTREGA_INVALIDO: 'Tipo de entrega inválido.',
  MODO_READONLY_NO_PERMITE_PEDIDOS: 'Este QR es solo para ver la carta, no toma pedidos.',
  PEDIDO_NO_PENDIENTE: 'El pedido ya no está pendiente de aprobación.',
  TELEFONO_REQUERIDO: 'Tenés que ingresar un teléfono.',
  TOKEN_INVALIDO: 'El token es inválido o expiró.',

  // ── Items config ─────────────────────────────────────────────────────
  REDONDEO_INVALIDO: 'El valor de redondeo no es válido.',

  // ── Facturas / remitos (compartidos con PASE) ────────────────────────
  FACTURA_ANULADA: 'La factura fue anulada.',
  FACTURA_NO_ENCONTRADA: 'La factura no existe.',
  FACTURA_YA_PAGADA: 'La factura ya fue pagada.',
  REMITO_ANULADO: 'El remito fue anulado.',
  REMITO_NO_ENCONTRADO: 'El remito no existe.',
  REMITO_YA_PAGADO: 'El remito ya fue pagado.',

  // ── Tenants / backup ──────────────────────────────────────────────────
  TENANT_NEKO_NOT_FOUND: 'No se encontró el tenant — contactar soporte.',
  TENANT_NOT_FOUND: 'El restaurante no existe.',
  TENANT_ES_DEL_CALLER: 'No podés borrar el tenant en el que estás autenticado.',
  CROSS_TENANT_RESTORE_BLOCKED: 'El backup pertenece a otro tenant.',
  BACKUP_INVALID: 'El archivo de backup tiene formato inválido.',
  BACKUP_VERSION_UNSUPPORTED: 'La versión del backup no es compatible.',
};

/**
 * Devuelve un mensaje en español para mostrar al usuario.
 *
 * Acepta:
 *   - PostgrestError u objetos `{ message }` típicos de supabase-js
 *   - Strings (mensajes ya formados o códigos sueltos)
 *   - null/undefined → 'Error desconocido.'
 *
 * Si el mensaje contiene un código mapeado, devuelve la traducción.
 * Si no, devuelve el mensaje crudo (mejor que vacío).
 */
export function translateError(err: { message?: string } | string | null | undefined): string {
  if (err == null) return 'Error desconocido.';
  const raw = (typeof err === 'string' ? err : err.message ?? '').trim();
  if (!raw) return 'Error desconocido.';
  for (const [code, msg] of Object.entries(TRADUCCIONES)) {
    if (raw.includes(code)) return msg;
  }
  return raw;
}
