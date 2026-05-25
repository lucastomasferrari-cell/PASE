// features.ts — catálogo central de feature flags por tenant.
//
// Sistema agregado 27-may noche por pedido de Lucas: "quiero administrar
// todas las funciones, no algunas — quiero elegir yo accesos a que les
// doy a cada cliente".
//
// Cómo funciona:
//   1. Cada feature tiene un `slug` único, descripción, categoría y un
//      `default_habilitado` (qué pasa si el tenant no tiene fila override).
//   2. Tabla `tenant_features` (migration 202605270300) guarda overrides.
//   3. Superadmin administra desde 2 UIs:
//      - Detalle por tenant: /tenants → botón "Funciones" en cada fila.
//      - Matriz: /tenants → tab "Funciones (matriz)" muestra tabla
//        tenants × features.
//   4. Frontend usa `useTenantFeatures()` hook + helper
//      `tenantTieneFeature(slug, features)` para gatear sidebar / rutas /
//      componentes.
//   5. Backend usa SQL helper `auth_tenant_tiene_feature(slug, default)`
//      para gatear desde RPCs.
//
// Para AGREGAR una feature nueva:
//   1. Sumarla a este array (slug único, descripción clara, categoría,
//      default sensato).
//   2. Donde toque gatear, usar `tenantTieneFeature("...")`.
//   3. No requiere migration — la tabla guarda solo overrides.
//
// Convención de slugs:
//   - `modulo.X` — un módulo completo (Caja, Compras, Ventas, etc.)
//   - `feature.X` — una sub-feature dentro de un módulo
//   - `integracion.X` — integración externa (MP, AFIP, Maxirest, etc.)
//   - `beta.X` — fase de prueba, default OFF para tenants nuevos.

export type FeatureCategoria =
  | "Operación"
  | "Dirección"
  | "Herramientas"
  | "Integraciones"
  | "Sistema"
  | "Beta";

export interface FeatureDef {
  /** Identificador único — usado en DB y código. NO cambiar después de release. */
  slug: string;
  /** Nombre visible en la UI superadmin. */
  label: string;
  /** Descripción larga para tooltip o info. Explicar qué pasa si se apaga. */
  descripcion: string;
  /** Agrupación visual en la UI. */
  categoria: FeatureCategoria;
  /** Valor cuando el tenant no tiene fila override. */
  default_habilitado: boolean;
  /** Si está en beta — la UI lo marca con badge. Default OFF para tenants nuevos. */
  beta?: boolean;
}

// ─── CATÁLOGO MAESTRO ──────────────────────────────────────────────────
// Ordenado por categoría → orden natural en la UI.
export const FEATURES: FeatureDef[] = [
  // ═══ OPERACIÓN ═══════════════════════════════════════════════════════
  {
    slug: "modulo.caja",
    label: "Caja",
    descripcion: "Movimientos de plata por cuenta (efectivo, banco, MP). Ingresos, egresos, transferencias, conciliaciones.",
    categoria: "Operación",
    default_habilitado: true,
  },
  {
    slug: "modulo.compras",
    label: "Compras (facturas + remitos)",
    descripcion: "Carga y gestión de facturas y remitos de proveedores. Pagos a proveedores.",
    categoria: "Operación",
    default_habilitado: true,
  },
  {
    slug: "modulo.ventas",
    label: "Ventas",
    descripcion: "Carga manual de ventas. Listado, búsqueda, anulación.",
    categoria: "Operación",
    default_habilitado: true,
  },
  {
    slug: "modulo.gastos",
    label: "Gastos",
    descripcion: "Carga y categorización de gastos del día (alquileres, impuestos, varios).",
    categoria: "Operación",
    default_habilitado: true,
  },
  {
    slug: "modulo.rrhh",
    label: "Equipo (RRHH)",
    descripcion: "Empleados, sueldos, adelantos, vacaciones, aguinaldo, liquidaciones, quincenas.",
    categoria: "Operación",
    default_habilitado: true,
  },

  // ═══ DIRECCIÓN ═══════════════════════════════════════════════════════
  {
    slug: "modulo.negocio",
    label: "Negocio (KPIs ejecutivos)",
    descripcion: "Vista del dueño: punto de equilibrio, objetivos del mes, comparativa entre sucursales.",
    categoria: "Dirección",
    default_habilitado: true,
  },
  {
    slug: "modulo.finanzas",
    label: "Finanzas",
    descripcion: "Vista consolidada de saldos, deuda con proveedores, cuentas por cobrar.",
    categoria: "Dirección",
    default_habilitado: true,
  },
  {
    slug: "modulo.rentabilidad",
    label: "Rentabilidad (Stock + CMV)",
    descripcion: "Módulo completo de stock: CMV real vs teórico, simulador de precios, conteo ciego, mermas, compras sugeridas.",
    categoria: "Dirección",
    default_habilitado: true,
  },
  {
    slug: "modulo.objetivos",
    label: "Objetivos",
    descripcion: "Definir metas mensuales por sucursal + tracking automático.",
    categoria: "Dirección",
    default_habilitado: true,
  },
  {
    slug: "modulo.reportes",
    label: "Reportes (EERR)",
    descripcion: "Estado de Resultados mensual base devengada. Gráficos de evolución.",
    categoria: "Dirección",
    default_habilitado: true,
  },

  // ═══ HERRAMIENTAS ════════════════════════════════════════════════════
  {
    slug: "modulo.mensajeria",
    label: "Mensajería (Bot Instagram + WhatsApp)",
    descripcion: "Bot IA que responde DMs y WhatsApps de clientes 24/7. Bandeja unificada. Add-on USD 20/mes.",
    categoria: "Herramientas",
    default_habilitado: false,
  },
  {
    slug: "modulo.contador",
    label: "Contador / IVA",
    descripcion: "Reportes mensuales para enviar al contador (libro IVA compras/ventas, percepciones, retenciones).",
    categoria: "Herramientas",
    default_habilitado: true,
  },
  {
    slug: "modulo.herramientas_hub",
    label: "Hub de Herramientas",
    descripcion: "Página /herramientas con accesos a Importar, Lector IA, Blindaje, etc.",
    categoria: "Herramientas",
    default_habilitado: true,
  },
  {
    slug: "feature.lector_facturas_ia",
    label: "Lector de facturas con IA",
    descripcion: "Subir foto/PDF de factura → IA extrae datos automáticamente. Usa API Claude.",
    categoria: "Herramientas",
    default_habilitado: true,
  },
  {
    slug: "feature.lector_mp",
    label: "Lector de extractos MP",
    descripcion: "Pegar Excel del extracto MP → parser detecta movimientos y los importa a Caja.",
    categoria: "Herramientas",
    default_habilitado: true,
  },
  {
    slug: "feature.blindaje",
    label: "Blindaje (snapshots/backups)",
    descripcion: "Tomar snapshots de la DB del tenant para restaurar en caso de problemas.",
    categoria: "Herramientas",
    default_habilitado: true,
  },
  {
    slug: "feature.conciliacion_bancaria",
    label: "Conciliación bancaria",
    descripcion: "Match automático entre movimientos cargados y extractos bancarios.",
    categoria: "Herramientas",
    default_habilitado: true,
  },
  {
    slug: "feature.importar",
    label: "Importar datos (Maxirest, CSV)",
    descripcion: "Importadores bulk: Maxirest, ventas CSV, insumos CSV, recetas CSV.",
    categoria: "Herramientas",
    default_habilitado: true,
  },

  // ═══ INTEGRACIONES ═══════════════════════════════════════════════════
  {
    slug: "integracion.mp",
    label: "Mercado Pago (conciliación)",
    descripcion: "Sync automático cada 30 min de movimientos MP. Conciliación contra ventas. Requiere token MP del cliente.",
    categoria: "Integraciones",
    default_habilitado: true,
  },
  {
    slug: "integracion.marketplace",
    label: "Marketplace propio + carta online",
    descripcion: "Página pública con dominio propio. Pedidos online cobrados por MP a la cuenta del cliente. Add-on USD 50/mes. Requiere COMANDA.",
    categoria: "Integraciones",
    default_habilitado: false,
  },
  {
    slug: "integracion.afip",
    label: "AFIP (facturación electrónica)",
    descripcion: "Emisión automática de facturas A/B/C con CAE de AFIP. Requiere certificado del cliente.",
    categoria: "Integraciones",
    default_habilitado: false,
    beta: true,
  },
  {
    slug: "integracion.comanda",
    label: "COMANDA (POS integrado)",
    descripcion: "Acceso al POS COMANDA desde pase-comanda.vercel.app con SSO. Catálogo, recetas, KDS, modo offline.",
    categoria: "Integraciones",
    default_habilitado: false,
  },

  // ═══ SISTEMA ═════════════════════════════════════════════════════════
  {
    slug: "modulo.usuarios",
    label: "Usuarios y permisos",
    descripcion: "Gestión de usuarios del tenant + roles + permisos por módulo + Manager Override TOTP.",
    categoria: "Sistema",
    default_habilitado: true,
  },
  {
    slug: "modulo.ajustes",
    label: "Ajustes (notificaciones, dashboards)",
    descripcion: "Configuración por usuario: notificaciones push, dashboards personalizados, códigos manager.",
    categoria: "Sistema",
    default_habilitado: true,
  },
  {
    slug: "feature.onboarding_wizard",
    label: "Wizard de onboarding",
    descripcion: "Pantalla /onboarding de 5 pasos que guía al dueño nuevo. Útil para tenants recién creados.",
    categoria: "Sistema",
    default_habilitado: true,
  },
  {
    slug: "feature.bandeja_entrada",
    label: "Bandeja de entrada",
    descripcion: "Inbox unificado con tickets de soporte + alertas del sistema + recordatorios.",
    categoria: "Sistema",
    default_habilitado: true,
  },

  // ═══ BETA / EN PRUEBA ════════════════════════════════════════════════
  {
    slug: "beta.gastro_sensei",
    label: "Gastro-Sensei IA (rentabilidad)",
    descripcion: "Botón en /rentabilidad que pide análisis a Claude IA sobre tu CMV y márgenes. En prueba — solo Neko.",
    categoria: "Beta",
    default_habilitado: false,
    beta: true,
  },
  {
    slug: "beta.compras_sugeridas",
    label: "Compras sugeridas (par-level)",
    descripcion: "Forecast semanal basado en ventas históricas. Sugiere qué insumos comprar y cuánto.",
    categoria: "Beta",
    default_habilitado: false,
    beta: true,
  },
  {
    slug: "beta.sub_recetas",
    label: "Sub-recetas / Prep items",
    descripcion: "Definir recetas compuestas de otras recetas (ej: salsa madre → 5 platos que la usan).",
    categoria: "Beta",
    default_habilitado: false,
    beta: true,
  },
  {
    slug: "beta.alertas_fuga",
    label: "Alertas posible fuga de stock",
    descripcion: "Notificación cuando un conteo físico termina con pérdida >$5k (posible robo/error).",
    categoria: "Beta",
    default_habilitado: false,
    beta: true,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────

/** Mapa de defaults por slug — útil para `tenantTieneFeature`. */
const DEFAULTS: Record<string, boolean> = Object.fromEntries(
  FEATURES.map((f) => [f.slug, f.default_habilitado]),
);

/**
 * Chequea si una feature está habilitada para el tenant actual.
 *
 * @param slug — feature slug del catálogo.
 * @param overrides — map de overrides cargado vía useTenantFeatures().
 *
 * Lógica:
 *   1. Si hay un override explícito → usar ese valor.
 *   2. Si no, usar `default_habilitado` del catálogo.
 *   3. Si el slug no existe en el catálogo → FALSE (defensivo).
 */
export function tenantTieneFeature(
  slug: string,
  overrides: Record<string, boolean> | null | undefined,
): boolean {
  if (overrides && slug in overrides) return overrides[slug] === true;
  return DEFAULTS[slug] ?? false;
}

/** Devuelve la definición de la feature o null si no existe. */
export function getFeatureDef(slug: string): FeatureDef | null {
  return FEATURES.find((f) => f.slug === slug) ?? null;
}

/** Agrupa el catálogo por categoría — para la UI. */
export function featuresPorCategoria(): Record<FeatureCategoria, FeatureDef[]> {
  const out: Record<string, FeatureDef[]> = {};
  for (const f of FEATURES) {
    if (!out[f.categoria]) out[f.categoria] = [];
    out[f.categoria]!.push(f);
  }
  return out as Record<FeatureCategoria, FeatureDef[]>;
}

/** Orden visual de las categorías en la UI. */
export const CATEGORIAS_ORDEN: FeatureCategoria[] = [
  "Operación",
  "Dirección",
  "Herramientas",
  "Integraciones",
  "Sistema",
  "Beta",
];
