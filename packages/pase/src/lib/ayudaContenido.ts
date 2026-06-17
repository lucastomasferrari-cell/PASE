// ─────────────────────────────────────────────────────────────────────────
// Contenido de la página de Ayuda (Lucas 17-jun).
//
// EN CONSTRUCCIÓN: arrancamos con las "preguntas clave" (casos de uso que
// enganchan: "¿dónde está la plata que ganaste?") + el "para qué sirve cada
// módulo" (pitch de valor). El manual detallado función-por-función se irá
// sumando cuando el sistema se estabilice (hoy cambia seguido).
//
// Contenido ESTÁTICO en código a propósito: se actualiza junto con las
// features (cuando se toca un módulo, se actualiza su ayuda en el mismo PR).
// ─────────────────────────────────────────────────────────────────────────

/** Pregunta-caso: el "para qué" que engancha + cómo lograrlo con el sistema. */
export interface PreguntaClave {
  /** La pregunta desde el dolor/objetivo del dueño. */
  q: string;
  /** Respuesta corta en castellano simple: qué módulo lo resuelve y cómo. */
  a: string;
  /** Módulo que lo resuelve (para el chip). */
  modulo: string;
  /** Ruta a la que llevar (botón "Ir a …"). Slug del sidebar. */
  ruta?: string;
}

/** Pitch de valor de un módulo: para qué te sirve (no qué es técnicamente). */
export interface ModuloAyuda {
  titulo: string;
  /** Para qué te sirve, en una o dos frases, desde el beneficio. */
  paraQue: string;
  ruta?: string;
  icon?: string;
}

// ─── Preguntas clave (set inicial — se amplía) ───────────────────────────
export const PREGUNTAS_CLAVE: PreguntaClave[] = [
  {
    q: "¿Dónde está la plata que ganaste el mes pasado?",
    a: "Tu ganancia (en Reportes) es “lo que facturaste menos lo que gastaste”, pero NO es la plata que tenés en el bolsillo: hay ventas que todavía no cobraste (MercadoPago tarda, tarjetas), plata en tránsito y compras de meses anteriores que pagaste ahora. El Cashflow te muestra la ruta real del dinero: qué entró, qué salió y dónde quedó parado.",
    modulo: "Cashflow",
    ruta: "/cashflow",
  },
  {
    q: "¿Cuánto puedo repartir sin quedarme corto?",
    a: "En Utilidades está el cálculo “seguro repartir”: toma la plata que tenés (operativa + reservada), le resta lo que falta pagar este mes (sueldos, fijos) y un colchón de seguridad, y te dice cuánto podés sacar sin descapitalizarte.",
    modulo: "Utilidades",
    ruta: "/utilidades",
  },
  {
    q: "¿Estás ganando o perdiendo este mes?",
    a: "En Reportes (Estado de Resultados) ves ventas, costo de mercadería, costo laboral y gastos, y la ganancia neta del mes — con el % de rentabilidad y el Prime Cost, el número que más se controla en gastronomía.",
    modulo: "Reportes",
    ruta: "/reportes",
  },
  {
    q: "¿Cuánto te cuesta DE VERDAD cada plato?",
    a: "En Rentabilidad cargás las recetas con sus insumos y precios, y el sistema te dice el costo real (CMV) de cada plato y tu margen. Después podés simular subir un precio y ver el impacto antes de tocar la carta.",
    modulo: "Rentabilidad",
    ruta: "/rentabilidad",
  },
  {
    q: "¿Qué le pasa a tu ganancia si subís los precios o te sube un costo?",
    a: "En Reportes tenés “Simular escenario”: tocás las líneas del balance (ventas, mercadería, sueldos…) en $ o en % y ves al instante cómo queda tu ganancia, sin tocar los datos reales.",
    modulo: "Reportes",
    ruta: "/reportes",
  },
  {
    q: "¿El extracto de MercadoPago coincide con lo que cargaste?",
    a: "En Conciliación subís el extracto de MP y el sistema cruza cada movimiento contra lo cargado en PASE: te marca lo que falta cargar, lo que sobra y lo que ya coincide, para cerrar el mes sin sorpresas.",
    modulo: "Conciliación",
    ruta: "/conciliacion-extracto",
  },
  {
    q: "¿Tu costo de personal es más alto de lo que creés?",
    a: "En Equipo llevás sueldos, adelantos, cargas sociales y boletas sindicales. En Reportes ves el “Costo laboral” total (sueldos + cargas) — el segundo costo más grande después de la mercadería, y el que más se descontrola.",
    modulo: "Equipo",
    ruta: "/equipo",
  },
  {
    q: "¿Llegás a tu objetivo de ventas del mes?",
    a: "En Objetivos ponés la meta de ventas del mes y el sistema te muestra cuánto llevás y cuánto te falta, actualizado solo día a día.",
    modulo: "Objetivos",
    ruta: "/objetivos",
  },
  {
    q: "¿Estás comprando de más, o pagando facturas dos veces?",
    a: "En Compras cargás facturas y remitos de proveedores (el lector con IA te lee la factura solo). Ves cuánto le comprás a cada proveedor, qué tenés pendiente de pagar y evitás pagar lo mismo dos veces.",
    modulo: "Compras",
    ruta: "/compras",
  },
];

// ─── ¿Para qué sirve cada módulo? (pitch de valor) ───────────────────────
export const MODULOS_AYUDA: ModuloAyuda[] = [
  { titulo: "Caja", icon: "💰", ruta: "/caja",
    paraQue: "El día a día de tu plata: qué entra y qué sale por cada cuenta (efectivo, banco, MercadoPago). Es tu tesorería — saber en todo momento cuánto tenés en cada lado." },
  { titulo: "Ventas", icon: "↑", ruta: "/ventas",
    paraQue: "Cargás las ventas del día por forma de cobro. Es la base de todo lo demás: ganancia, objetivos y rentabilidad salen de acá." },
  { titulo: "Compras", icon: "📄", ruta: "/compras",
    paraQue: "Facturas y remitos de proveedores en un solo lugar, con lector de IA que carga la factura por vos. Controlás cuánto comprás, a quién, y qué falta pagar." },
  { titulo: "Gastos", icon: "💸", ruta: "/gastos",
    paraQue: "Todos los gastos del local ordenados por tipo (fijos, variables, impuestos, mano de obra…) para saber exactamente en qué se te va la plata." },
  { titulo: "Equipo", icon: "👥", ruta: "/equipo",
    paraQue: "Toda la nómina sin planillas sueltas: sueldos, adelantos, vacaciones, aguinaldo, cargas sociales y boletas sindicales." },
  { titulo: "Recetario / Rentabilidad", icon: "📈", ruta: "/rentabilidad",
    paraQue: "El lugar donde se protege la ganancia: costo real de cada plato, margen, simulador de precios y control de stock (CMV real vs teórico)." },
  { titulo: "Conciliación", icon: "✅", ruta: "/conciliacion-extracto",
    paraQue: "Cruzás el extracto de MercadoPago contra lo cargado para cerrar el mes cuadrado, sin movimientos fantasma." },
  { titulo: "Negocio", icon: "📊", ruta: "/negocio",
    paraQue: "La vista del dueño: KPIs, punto de equilibrio y comparación entre sucursales de un vistazo." },
  { titulo: "Reportes (Estado de Resultados)", icon: "📈", ruta: "/reportes",
    paraQue: "El balance del mes: si ganás o perdés, con qué margen, y un simulador para probar escenarios antes de decidir." },
  { titulo: "Cashflow", icon: "💵", ruta: "/cashflow",
    paraQue: "La ruta real del dinero (lo que efectivamente entró y salió): a dónde fue tu plata, más allá de la ganancia contable." },
  { titulo: "Utilidades", icon: "🤝", ruta: "/utilidades",
    paraQue: "Cuánto podés repartir sin descapitalizarte, más el registro de la caja de utilidades y los retiros de cada socio." },
  { titulo: "Objetivos", icon: "◎", ruta: "/objetivos",
    paraQue: "Metas de ventas por mes con seguimiento automático: cuánto llevás y cuánto te falta." },
];
