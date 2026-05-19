// Tipos para AFIP facturación electrónica WSFEv1.
//
// Referencias:
//   - https://www.afip.gob.ar/fe/documentos/manual-desarrollador-COMPGv2.10.pdf
//   - https://docs.afipsdk.com/

export type AfipAmbiente = 'testing' | 'produccion';

export type AfipTipoComprobante =
  | 1   // Factura A
  | 6   // Factura B
  | 11  // Factura C
  | 3   // Nota de Crédito A
  | 8   // Nota de Crédito B
  | 13  // Nota de Crédito C
  | 2   // Nota de Débito A
  | 7   // Nota de Débito B
  | 12  // Nota de Débito C
  | 51  // Factura M
  | 56  // Comprobante M
  | 61  // Recibo C
  | 66  // Liquidación de venta primaria
  | 81  // Tique factura A
  | 86  // Tique factura B
  | 91  // Comprobante turista A
  | 96; // Comprobante turista B

/** Para NC/ND: referencia al comprobante original. */
export interface AfipCbteAsoc {
  tipo: AfipTipoComprobante;
  pto_vta?: number;
  numero: number;
  cuit?: string;
}

export type AfipConcepto = 1 | 2 | 3;
// 1 = Productos | 2 = Servicios | 3 = Productos y Servicios

export type AfipDocTipo =
  | 80  // CUIT
  | 86  // CUIL
  | 87  // CDI
  | 89  // LE
  | 90  // LC
  | 91  // CI Extranjera
  | 92  // En trámite
  | 93  // Acta nacimiento
  | 94  // Pasaporte
  | 96  // DNI
  | 99; // Consumidor final (sin doc)

export interface AfipCredencialesPublic {
  tenant_id: string;
  cuit: string;
  ambiente: AfipAmbiente;
  punto_venta: number;
  tipo_contribuyente: 'monotributo' | 'responsable_inscripto' | 'exento';
  cert_vence_at: string | null;
  ultimo_token_at: string | null;
  activa: boolean;
}

export interface AfipFacturaInput {
  tenant_id: string;
  venta_pos_id: number;
  tipo_comprobante: AfipTipoComprobante;
  importe_neto: number;
  importe_iva: number;
  importe_total: number;
  concepto: AfipConcepto;
  doc_tipo?: AfipDocTipo;
  doc_nro?: string;
  cliente_razon_social?: string;
  request_uuid: string; // UUID estable para idempotency
  /** Para NC/ND: referencia a la factura original. AFIP rechaza si falta. */
  cbtes_asoc?: AfipCbteAsoc[];
}

export interface AfipFacturaResult {
  factura_id: number;
  cae: string;
  cae_vence_at: string; // YYYY-MM-DD
  numero: number;
  qr_fiscal_url: string;
  estado: 'aprobada' | 'rechazada';
  rechazo_motivo: string | null;
}

export interface AfipError {
  code: string;
  message: string;
}
