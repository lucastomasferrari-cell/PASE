export const CATEGORIAS_COMPRA = ["PESCADERIA","CARNICERIA","VERDULERIA","BEBIDAS","VINOS","ALMACEN","PACKAGING","PAPELERIA","BARRIO CHINO","PRODUCTOS ORIENTALES","SUPERMERCADO","HIELO","LIMPIEZA","CONTADOR","PUBLICIDAD","EXPENSAS","PROPINAS","SUSHIMAN PM","EQUIPAMIENTO","SUELDOS","OTROS"];
// Fallback offline de useMediosCobro — si la DB no responde, el hook usa
// estos arrays para que los dropdowns y el cálculo de impacto-en-caja sigan
// funcionando. La fuente de verdad real es la tabla medios_cobro
// (refactor C, migration 20260424). Editar Configuración → Medios de cobro.
export const MEDIOS_COBRO = ["EFECTIVO SALON","TARJETA CREDITO","TARJETA DEBITO","QR","LINK","RAPPI ONLINE","PEYA ONLINE","PEYA EFECTIVO","MP DELIVERY","BIGBOX","FANBAG","EVENTO","TRANSFERENCIA","Point MP","Point Nave","NAVE","MASDELIVERY ONLINE","EFECTIVO DELIVERY"];
export const MEDIO_A_CUENTA: Record<string, string | null> = {
  "EFECTIVO SALON":    "Caja Chica",
  "EFECTIVO DELIVERY": "Caja Chica",
  "PEYA EFECTIVO":     "Caja Chica",
  "EVENTO":            "Caja Chica",
  // Todo lo demás: null = no impacta en caja
  "TARJETA CREDITO":   null,
  "TARJETA DEBITO":    null,
  "QR":                null,
  "LINK":              null,
  "TRANSFERENCIA":     null,
  "RAPPI ONLINE":      null,
  "PEYA ONLINE":       null,
  "MP DELIVERY":       null,
  "MASDELIVERY ONLINE":null,
  "BIGBOX":            null,
  "FANBAG":            null,
  "Point MP":          null,
  "Point Nave":        null,
  "NAVE":              null,
};
// 5 cuentas totales. Las 2 últimas (MercadoPago, Banco) están en
// CUENTAS_OCULTAS_TEMPORAL: los widgets/cards de saldo NO las muestran
// (decisión Lucas 2026-05-17: saldos no son reales sin conciliación
// automática) — pero siguen disponibles como cuentas OPERABLES para
// pagar facturas/gastos y registrar movimientos. Cuando se cierre la
// conciliación, se saca CUENTAS_OCULTAS_TEMPORAL y aparecen los saldos.
export const CUENTAS = ["Caja Chica","Caja Mayor","Caja Efectivo","MercadoPago","Banco"];
// Cuentas con saldo no-mostrable en widgets/pantalla Caja (NO afecta
// dropdowns de pago, ni listados de movimientos). Solo es filtro VISUAL
// de las cards de saldo.
export const CUENTAS_OCULTAS_TEMPORAL = ["MercadoPago", "Banco"];
export const UNIDADES = ["kg","g","litro","ml","unidad","caja","bolsa","docena"];
export const GASTOS_FIJOS = ["ALQUILER","EDESUR","METROGAS","AYSA","INTERNET","MAXIREST","WOKI","SEGURO","FUMIGACION","ABL","EXPENSAS","AQA","CONTADOR","OTROS FIJOS"];
export const GASTOS_VARIABLES = ["COMPRAS MERCADO LIBRE","ENVIOS","LIBRERIA","BAZAR","FARMACIA","MANTENIMIENTO","EQUIPAMIENTO","DEVOLUCIONES CLIENTES","PERSONAL","AJUSTE","GASTOS VARIOS"];
export const GASTOS_PUBLICIDAD = ["PIMENTON","COMMUNITY MANAGER","PRENSA Y PAUTA FB","FOTOGRAFIA Y ACCIONES","RAPPI CUOTA ADS","OTRAS PUBLICIDAD"];
export const COMISIONES_CATS = ["MERCADOPAGO","RAPPI","PEDIDOS YA","MASDELIVERY","BANCARIAS NAVE","COMPENSACIONES","OTRAS COMISIONES"];
export const GASTOS_IMPUESTOS = ["IVA","IIBB","RETENCIONES","MONOTRIBUTO / AUTONOMOS","SELLOS","OTROS IMPUESTOS"];
