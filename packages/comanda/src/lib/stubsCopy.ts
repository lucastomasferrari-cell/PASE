import {
  TrendingUp, UserCheck, Layers, Calendar, Clock,
  Banknote, History, Wallet, FileSpreadsheet, ShoppingBag, Truck,
  Printer, Box, CreditCard, Tablet, Tag, Ticket, Award, MailPlus,
  Users, BookOpen, Star, Briefcase, Truck as RappiIcon, Bike,
  MessageCircle, Calculator, Code, Image, Bell, Receipt, Languages,
  Database, FileText, Banknote as BillingIcon, History as HistoryIcon,
  type LucideIcon,
} from 'lucide-react';

// Diccionario centralizado de copy para todas las pantallas stub.
// Lookup por slug completo de la ruta (ej. '/menu/combos').
//
// Cada entrada define titulo, descripcion, icono y features (bullets que
// describen qué va a poder hacer el usuario cuando la feature esté lista).
//
// Si una entrada NO existe en este map, StubPantalla renderiza con un
// fallback genérico. Mantener este map en sync con adminNavigation.ts —
// si agregás una sub-ruta nueva con badge:'soon', agregá su copy acá.

export interface StubCopy {
  titulo: string;
  descripcion: string;
  icono: LucideIcon;
  features: string[];
}

export const STUBS_COPY: Record<string, StubCopy> = {
  // ─── Reportes ────────────────────────────────────────────────────────────
  '/reportes/ventas': {
    titulo: 'Reporte de ventas',
    descripcion: 'Análisis profundo de tus ventas con cortes por período, canal, hora y mucho más.',
    icono: TrendingUp,
    features: [
      'Comparación con período anterior con flecha y % de variación',
      'Heatmap de hora pico por día de la semana',
      'Ticket promedio + cantidad de ventas por cajero',
      'Banners automáticos de caídas y picos relevantes',
      'Exportar CSV / Excel para tu contador',
    ],
  },
  '/reportes/empleados': {
    titulo: 'Performance de empleados',
    descripcion: 'Métricas individuales por cajero/encargado: ventas, propinas, tiempos de atención.',
    icono: UserCheck,
    features: [
      'Ranking de cajeros por ventas del mes',
      'Tasa de descuentos aplicados por empleado',
      'Tiempo promedio de turno y de atención por mesa',
      'Propinas recibidas (cuando se cargan en POS)',
      'Comparación entre turnos del mismo empleado',
    ],
  },

  // ─── Menú ────────────────────────────────────────────────────────────────
  '/menu/combos': {
    titulo: 'Combos y promociones',
    descripcion: 'Definí combos (item compuesto) y promos cruzadas con descuento específico.',
    icono: Layers,
    features: [
      'Combo "Hamburguesa + papas + bebida" con precio especial',
      'Promo "10% off" cuando se compran 3+ items de la misma categoría',
      'Activación por canal (solo POS, solo tienda online, ambos)',
      'Vencimiento configurable (válido hasta tal fecha)',
      'Reportes de cuántas veces se vendió cada combo',
    ],
  },
  '/menu/disponibilidad': {
    titulo: 'Disponibilidad de items (86)',
    descripcion: 'Marcá items "agotados" / "86" en tiempo real para que el POS y la tienda los oculten.',
    icono: Calendar,
    features: [
      'Toggle rápido por item para marcarlo agotado',
      'Bulk: marcar varios a la vez por grupo o búsqueda',
      'Auto-restock al cierre del turno o por horario',
      'Historial de cuántas veces se agotó un item',
      'Notificación al POS cuando se intenta vender un item agotado',
    ],
  },

  // ─── Salón ───────────────────────────────────────────────────────────────
  '/salon/servicios': {
    titulo: 'Servicios y turnos',
    descripcion: 'Definí los servicios del día (almuerzo, cena, brunch) con su horario y reglas.',
    icono: Clock,
    features: [
      'Servicios con horario start/end por día',
      'Menús específicos por servicio (carta brunch vs cena)',
      'Configuración de propina sugerida por servicio',
      'Reportes filtrables por servicio',
      'Auto-cambio de servicio según hora del día',
    ],
  },
  // Reservas eliminadas 17-jul: la feature vive en MESA.

  // ─── Empleados ───────────────────────────────────────────────────────────
  '/empleados/horarios': {
    titulo: 'Horarios y turnos',
    descripcion: 'Planificá los turnos de los empleados y trackeá ausencias.',
    icono: Calendar,
    features: [
      'Calendario semanal con drag & drop de turnos',
      'Cálculo automático de horas trabajadas',
      'Solicitud de cambios entre empleados',
      'Notificaciones de turno por WhatsApp',
      'Exportar para liquidación de sueldos',
    ],
  },
  '/empleados/performance': {
    titulo: 'Performance individual',
    descripcion: 'Métricas detalladas de cada empleado para feedback y revisiones.',
    icono: UserCheck,
    features: [
      'Velocidad de atención por mesa',
      'Cantidad de ventas y descuentos del período',
      'Errores en pedidos (anulaciones, devoluciones)',
      'Comparativa entre miembros del mismo equipo',
      'Plantilla automática para revisión mensual',
    ],
  },

  // ─── Pagos y caja ────────────────────────────────────────────────────────
  '/pagos/caja-chica': {
    titulo: 'Caja chica',
    descripcion: 'Manejá los gastos chicos del día (insumos urgentes, propinas en efectivo, etc.).',
    icono: Banknote,
    features: [
      'Registro rápido de gastos con foto del comprobante',
      'Categorización por concepto (insumos, limpieza, otros)',
      'Saldo de caja chica visible en el POS',
      'Reposición desde caja principal con audit',
      'Reporte semanal de gastos por categoría',
    ],
  },
  '/pagos/historico-turnos': {
    titulo: 'Histórico de turnos',
    descripcion: 'Vista consolidada de todos los turnos de caja cerrados con sus diferencias.',
    icono: History,
    features: [
      'Filtros por cajero, fecha, local',
      'Detalle de movimientos por turno',
      'Diferencias positivas/negativas resaltadas',
      'Exportación CSV para conciliar con contabilidad',
      'Drill-down al detalle de cada movimiento',
    ],
  },
  '/pagos/conciliacion-mp': {
    titulo: 'Conciliación Mercado Pago',
    descripcion: 'Cruce automático de las ventas POS con los pagos recibidos en MP.',
    icono: Wallet,
    features: [
      'Match automático venta ↔ pago por monto + fecha',
      'Detección de pagos huérfanos (sin venta asociada)',
      'Detección de ventas sin pago confirmado',
      'Vinculación manual cuando el match falla',
      'Integración con el módulo MP del paquete PASE',
    ],
  },
  '/pagos/settlements': {
    titulo: 'Settlements',
    descripcion: 'Liquidaciones diarias/semanales por canal: Mercado Pago, Rappi, PedidosYa, etc.',
    icono: FileSpreadsheet,
    features: [
      'Resumen de cada settlement con detalle de comisiones',
      'Cruce con las ventas POS para detectar diferencias',
      'Estimación de fecha de acreditación',
      'Reporte mensual consolidado por canal',
      'Integración con el módulo settlements del paquete PASE',
    ],
  },

  // ─── Online ──────────────────────────────────────────────────────────────
  '/online/tienda': {
    titulo: 'Tienda online (configuración)',
    descripcion: 'Configurá tu storefront público: slug, branding, métodos de pago, horario.',
    icono: ShoppingBag,
    features: [
      'Slug público (ej. /tienda/villa-crespo)',
      'Logo y colores que matcheen tu marca',
      'Activar / pausar pedidos online por horario',
      'Costo de envío por zona (cuando se implementen polígonos)',
      'Métodos de pago aceptados (efectivo, MP QR, transferencia)',
    ],
  },
  '/online/tracking': {
    titulo: 'Tracking de pedidos online',
    descripcion: 'Vista en tiempo real de los pedidos de la tienda online, con su estado.',
    icono: Truck,
    features: [
      'Lista de pedidos activos por estado (recibido, en cocina, listo, en camino)',
      'Cambio rápido de estado desde acá',
      'Tiempo transcurrido desde que se hizo el pedido',
      'Alertas si un pedido lleva más de X min sin avanzar',
      'Notificación al cliente al cambiar de estado',
    ],
  },

  // ─── Hardware ────────────────────────────────────────────────────────────
  '/hardware/impresoras': {
    titulo: 'Impresoras térmicas',
    descripcion: 'Configurá las impresoras de cocina, barra y caja. Asigná qué estación imprime cada ticket.',
    icono: Printer,
    features: [
      'Registrar impresoras térmicas por IP',
      'Asignar estaciones (cocina caliente, barra, postres)',
      'Configurar formato de tickets (logo, ancho, idioma)',
      'Test de impresión desde la pantalla',
      'Marcar impresoras offline cuando no responden',
    ],
  },
  '/hardware/cajon': {
    titulo: 'Cajón de dinero',
    descripcion: 'Manejá la apertura del cajón de caja conectado por impresora térmica.',
    icono: Box,
    features: [
      'Apertura automática al cobrar en efectivo',
      'Apertura manual con motivo (anular venta, dar vuelto sin venta)',
      'Audit log de cada apertura con empleado y motivo',
      'Configuración de qué eventos abren el cajón',
      'Alarma sonora si queda abierto más de X seg',
    ],
  },
  '/hardware/mp-point': {
    titulo: 'MP Point (terminales)',
    descripcion: 'Vinculá las terminales Mercado Pago Point para cobrar con tarjeta directo desde el POS.',
    icono: CreditCard,
    features: [
      'Vinculación con tu cuenta MP del local',
      'Asignar terminal a cada caja/cajero',
      'Cobrar tarjeta sin tipear monto (se manda desde POS)',
      'Pagos llegan ya conciliados con la venta',
      'Soporte para tip y propina en la terminal',
    ],
  },
  '/hardware/tablets-kds': {
    titulo: 'Tablets KDS',
    descripcion: 'Inventario de las tablets/pantallas conectadas al KDS.',
    icono: Tablet,
    features: [
      'Lista de dispositivos KDS por estación',
      'Estado online/offline en tiempo real',
      'Última actividad y batería (si hay)',
      'Renovar token de acceso cuando se pierde el dispositivo',
      'Versión del cliente KDS instalada',
    ],
  },

  // ─── Marketing ───────────────────────────────────────────────────────────
  '/marketing/promociones': {
    titulo: 'Promociones y descuentos',
    descripcion: 'Creá descuentos automáticos que se apliquen en POS y tienda online.',
    icono: Tag,
    features: [
      '2x1 los martes en cervezas',
      '10% de descuento para clientes nuevos',
      'Combo del día con precio especial',
      'Happy hour por hora del día',
      'Descuentos por canal (Rappi, Tienda propia, etc.)',
    ],
  },
  '/marketing/cupones': {
    titulo: 'Cupones',
    descripcion: 'Generá cupones únicos con código para repartir en redes o emails.',
    icono: Ticket,
    features: [
      'Cupones únicos o de uso múltiple',
      'Vencimiento configurable',
      'Restricción por monto mínimo de compra',
      'Tracking de cuántos se usaron',
      'Generación masiva (ej. 100 cupones para una campaña)',
    ],
  },
  '/marketing/fidelidad': {
    titulo: 'Programa de fidelidad',
    descripcion: 'Tu programa de puntos / sellos / niveles para retener clientes.',
    icono: Award,
    features: [
      'Sumar puntos por cada $X gastados',
      'Canje de puntos por items o descuentos',
      'Niveles (Bronze, Silver, Gold) con beneficios',
      'Notificaciones automáticas al cumplir hito',
      'Reportes de impacto del programa en frecuencia',
    ],
  },
  '/marketing/campanas': {
    titulo: 'Campañas Email / WhatsApp',
    descripcion: 'Mandá campañas a tu base de clientes desde un solo lugar.',
    icono: MailPlus,
    features: [
      'Templates de email pre-diseñados',
      'Envío masivo segmentado (clientes nuevos, VIP, inactivos)',
      'Tracking de aperturas y clicks',
      'Programación de envíos a futuro',
      'Integración WhatsApp Business',
    ],
  },

  // ─── Clientes ────────────────────────────────────────────────────────────
  '/clientes/lista': {
    titulo: 'Lista de clientes',
    descripcion: 'Tu base de clientes consolidada de todos los canales.',
    icono: Users,
    features: [
      'Ver todos los clientes que pasaron por la tienda online',
      'Historial completo de pedidos por cliente',
      'Métricas: cuántas veces vino, ticket promedio, último pedido',
      'Tags y notas personalizadas',
      'Base para campañas de marketing y fidelización',
    ],
  },
  '/clientes/historial': {
    titulo: 'Historial de pedidos',
    descripcion: 'Vista cronológica de todos los pedidos de un cliente.',
    icono: BookOpen,
    features: [
      'Buscador por nombre o teléfono',
      'Detalle de cada pedido con items y total',
      'Repetir pedido desde el POS',
      'Promediar ticket / frecuencia',
      'Notas internas por cliente (alergias, preferencias)',
    ],
  },
  '/clientes/resenas': {
    titulo: 'Reseñas',
    descripcion: 'Reseñas que dejaron tus clientes en la tienda online y en plataformas externas.',
    icono: Star,
    features: [
      'Reseñas internas (post-pedido tienda online)',
      'Reseñas de Google Business / TripAdvisor',
      'Notificación inmediata de reseñas <4★',
      'Respuesta rápida desde acá',
      'Score consolidado y tendencia',
    ],
  },

  // ─── Integraciones ───────────────────────────────────────────────────────
  '/integraciones/mercadopago': {
    titulo: 'Mercado Pago',
    descripcion: 'Conectá tu cuenta MP para conciliar pagos automáticamente y recibir cobros.',
    icono: Briefcase,
    features: [
      'OAuth con tu cuenta MP',
      'Webhooks de pagos recibidos',
      'Sincronización automática con conciliación',
      'Reportes consolidados',
      'Soporte para terminal Point (ver Hardware)',
    ],
  },
  '/integraciones/rappi': {
    titulo: 'Rappi',
    descripcion: 'Recibí pedidos de Rappi directo en el KDS y reconciliá settlements.',
    icono: RappiIcon,
    features: [
      'Pedidos Rappi aparecen en el KDS automáticamente',
      'Cambio de estado se sincroniza con Rappi',
      'Settlements semanales con detalle de comisiones',
      'Mapping de items Rappi ↔ items locales',
      'Pausar Rappi cuando estás colapsado',
    ],
  },
  '/integraciones/pedidosya': {
    titulo: 'PedidosYa',
    descripcion: 'Misma integración que Rappi pero para PedidosYa.',
    icono: Bike,
    features: [
      'Pedidos PYa aparecen en el KDS automáticamente',
      'Cambio de estado se sincroniza con PYa',
      'Settlements con detalle de comisiones',
      'Mapping de items PYa ↔ items locales',
      'Pausar PYa cuando estás colapsado',
    ],
  },
  '/integraciones/whatsapp': {
    titulo: 'WhatsApp Business',
    descripcion: 'Notificaciones automáticas de pedidos y campañas por WhatsApp.',
    icono: MessageCircle,
    features: [
      'Cambio de estado de pedido notificado al cliente',
      'Confirmación de reserva por WhatsApp',
      'Campañas masivas (con consentimiento del cliente)',
      'Atención al cliente desde el dashboard',
      'Templates pre-aprobados por WhatsApp',
    ],
  },
  '/integraciones/contabilidad': {
    titulo: 'Contabilidad',
    descripcion: 'Exportación de ventas + gastos al sistema contable de tu contador.',
    icono: Calculator,
    features: [
      'Exportar mensualmente a Excel / CSV',
      'Integración directa con Xubio, Tangocod, Holded',
      'Conciliación de IVA crédito/débito',
      'Mapping de categorías comanda ↔ plan de cuentas',
      'Audit trail con sello del contador',
    ],
  },
  '/integraciones/api': {
    titulo: 'Webhooks / API',
    descripcion: 'Conectá tu propio sistema con la API REST de comanda.',
    icono: Code,
    features: [
      'Webhooks por evento (venta cobrada, pedido recibido, etc.)',
      'API key + secret por integración',
      'Documentación OpenAPI',
      'Rate limiting visible',
      'Logs de requests para debugging',
    ],
  },

  // ─── Configuración ───────────────────────────────────────────────────────
  '/configuracion/branding': {
    titulo: 'Branding y logos',
    descripcion: 'Tu logo, colores y assets para tickets, tienda online y reportes.',
    icono: Image,
    features: [
      'Subir logo principal y variante para tickets',
      'Color principal de la marca',
      'Tipografía',
      'Footer customizable en tickets',
      'Preview en vivo de cómo queda',
    ],
  },
  '/configuracion/notificaciones': {
    titulo: 'Notificaciones',
    descripcion: 'Qué eventos del sistema te notifican y por dónde.',
    icono: Bell,
    features: [
      'Suscripción a eventos: pedido nuevo, venta anulada, error de impresora',
      'Canales: email, WhatsApp, push del navegador',
      'Quiet hours (no notificar entre tales horas)',
      'Notificar a empleado responsable según el evento',
      'Resumen diario / semanal opt-in',
    ],
  },
  '/configuracion/recibos': {
    titulo: 'Recibos e impresión',
    descripcion: 'Personalización del ticket que se imprime y se envía al cliente.',
    icono: Receipt,
    features: [
      'Header con logo + datos fiscales',
      'Footer con redes sociales y agradecimiento',
      'QR para reseña al final del ticket',
      'Idioma del ticket por canal',
      'Preview de cómo va a quedar impreso',
    ],
  },
  '/configuracion/idioma': {
    titulo: 'Idioma y zona horaria',
    descripcion: 'Configurá idioma de la UI y zona horaria del local.',
    icono: Languages,
    features: [
      'Idioma de la UI (español AR, español ES, inglés)',
      'Zona horaria (default America/Argentina/Buenos_Aires)',
      'Formato de fecha y hora',
      'Moneda + locale (es-AR / es-MX / es-UY)',
      'Idiomas de los tickets impresos',
    ],
  },
  '/configuracion/backup': {
    titulo: 'Backup y exportación',
    descripcion: 'Exportá todo tu sistema en un archivo (JSON/CSV) para backup propio.',
    icono: Database,
    features: [
      'Backup completo bajo demanda',
      'Backup automático nocturno',
      'Restore desde backup (caso disaster)',
      'Export por entidad (items, ventas, clientes)',
      'GDPR-style: borrar todos los datos de un cliente',
    ],
  },

  // ─── Suscripción ─────────────────────────────────────────────────────────
  '/suscripcion/plan': {
    titulo: 'Tu plan actual',
    descripcion: 'Detalles de tu suscripción a comanda y opciones de cambio.',
    icono: FileText,
    features: [
      'Plan vigente (Free / Pro / Enterprise)',
      'Features incluidas y límites de uso',
      'Próxima facturación',
      'Upgrade / downgrade con prorrateo',
      'Pausa temporal del plan',
    ],
  },
  '/suscripcion/facturacion': {
    titulo: 'Facturación',
    descripcion: 'Datos fiscales para tus facturas de comanda.',
    icono: BillingIcon,
    features: [
      'Razón social, CUIT, condición IVA',
      'Dirección fiscal y email contable',
      'Configuración de facturación electrónica',
      'Reenvío de facturas perdidas',
      'Historial fiscal exportable',
    ],
  },
  '/suscripcion/metodos-pago': {
    titulo: 'Métodos de pago',
    descripcion: 'Cómo pagás tu suscripción a comanda.',
    icono: CreditCard,
    features: [
      'Tarjeta de crédito (con CBU como backup)',
      'Cambio de método sin perder cobertura',
      'Trial de 30 días sin tarjeta requerida',
      'Cobro automático mensual',
      'Notificación 7 días antes del cobro',
    ],
  },
  '/suscripcion/historial': {
    titulo: 'Historial de pagos',
    descripcion: 'Listado completo de tus pagos a comanda.',
    icono: HistoryIcon,
    features: [
      'Cada pago con su factura PDF',
      'Estados (cobrado, rechazado, reintento)',
      'Reintentos automáticos en caso de rechazo',
      'Período de gracia configurable',
      'Exportable para tu contador',
    ],
  },
};
