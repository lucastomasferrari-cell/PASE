// Tipos del módulo Compras. Extraídos de Compras.tsx en F9 split
// (2026-05-11).

// Remito (table remitos) — registro de mercadería recibida sin factura
// inmediata. Modelo separado en DB pero unificado en UI con Compras desde
// 2026-05-07. Estados: 'sin_factura'/'vinculado'/'facturado'/'pagado'/'anulado'.
export interface Remito {
  id: string;
  prov_id: number;
  local_id: number;
  nro: string;
  fecha: string;
  monto: number;
  cat: string | null;
  detalle: string | null;
  estado: string;
  factura_id: string | null;
}

// Forma del state form (carga manual de factura). Los campos numéricos son
// number desde el CurrencyInput (antes string, parseMonto-eados).
export interface FormFactura {
  prov_id: string;
  local_id: string;
  nro: string;
  fecha: string;
  venc: string;
  // Sprint CurrencyInput: campos de plata como number. El currency mask del
  // CurrencyInput trabaja directo con number; elimina el bug del neto
  // gravado por type=number rechazando coma AR.
  neto: number;
  iva21: number;
  iva105: number;
  iibb: number;        // total IIBB (suma de las 3 jurisdicciones) — cache
  perc_iva: number;
  otros_cargos: number;
  descuentos: number;
  cat: string;
  detalle: string;
  tipo: string;
  // Discriminación fiscal AR (Lucas 10-jun, Libro IVA Compras del contador).
  // Defaults a 0 en el form; el panel "Discriminación fiscal" del modal los
  // muestra colapsados hasta que el usuario los necesite.
  iva27: number;
  no_gravado: number;
  exento: number;
  iibb_caba: number;
  iibb_ba: number;
  iibb_otros: number;
  iibb_otros_jurisdiccion: string;
  perc_ganancias: number;
  retencion_suss: number;
}

// Forma del state form (cargar remito valorado).
export interface FormRemito {
  prov_id: string;
  local_id: string;
  nro: string;
  fecha: string;
  monto: number;
  cat: string;
  detalle: string;
}

// Forma del state form (pagar remito directo, sin factura previa).
export interface FormPagoRemito {
  cuenta: string;
  monto: number;
  fecha: string;
}

// Item del detalle de insumos (form item editable).
// materia_prima_id: opcional. Si se setea, dispara trigger SQL que actualiza
// el costo del insumo unificado vinculado (refactor CMV 2026-05-15).
export interface ItemFactura {
  producto: string;
  cantidad: string;
  unidad: string;
  precio_unitario: string;
  subtotal: number;
  materia_prima_id?: number | null;
}
