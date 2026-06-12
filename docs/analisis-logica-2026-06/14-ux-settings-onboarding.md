# 14 — UX de Configuración (Ajustes) y Onboarding Día-1

**Investigación de patrones — junio 2026**
Foco: software B2B operativo, POS y gestión gastronómica (Square, Toast, Shopify, Stripe, Fudo, + literatura UX).
Contexto: evaluar el modelo actual de Ajustes de PASE (buscador global + 6 secciones colapsables de catálogos, 151 items) contra lo que hacen los mejores, con la meta declarada de Lucas: *"que la gente entienda el día 1 cómo funciona todo, ultra intuitivo, la UX/UI como diferenciación"*.

---

## 1. Cómo estructuran settings los mejores

### 1.1 Shopify — el referente mundial de settings B2B

- **Settings es un área separada del trabajo diario.** El admin de Shopify tiene una sección Settings con navegación lateral propia (~20 secciones: General, Plan, Billing, Users, Payments, Checkout, Shipping, Taxes, Locations, Notifications, etc.), accesible desde un único punto de entrada abajo a la izquierda. Los catálogos operativos (productos, colecciones, clientes) **NO viven en Settings** — viven en la navegación principal porque se tocan todos los días. ([Shopify Help — Settings](https://help.shopify.com/en/manual/your-account/account-settings))
- **Regla de oro implícita: Settings = cosas que configurás una vez y tocás poco. Catálogo = cosas vivas del negocio.** Esta separación es la decisión estructural más importante que toman todos los grandes.
- Su guía oficial de diseño para páginas de settings dice: páginas **escaneables**, ancho angosto para mantener foco, **secciones temáticas con ayuda contextual al lado de cada control**, settings complejos divididos en sub-páginas propias, save bar que protege cambios sin guardar, confirmación con toast, modal para acciones destructivas. ([shopify.dev — Settings pattern](https://shopify.dev/docs/api/app-home/patterns/templates/settings), [App Design Guidelines](https://shopify.dev/docs/apps/design))
- Agrupan **por dominio funcional** (pagos, envíos, impuestos, notificaciones), no por frecuencia ni por orden alfabético. La frecuencia se maneja sacando lo frecuente *fuera* de settings.

### 1.2 Square — settings templates y modos por tipo de negocio

- Square Dashboard organiza en `Settings > Account & Settings` (negocio: nombre, locales, seguridad, idioma) vs `Settings > Device Management` (dispositivos). Lo operativo (items, categorías, descuentos, impuestos) vive en el área de catálogo, no en settings. ([Square Support — Account settings](https://squareup.com/help/us/en/subtopic/dashboard-account-settings), [Edit account and business settings](https://squareup.com/help/us/en/article/3861-edit-your-account-and-business-settings))
- **Patrón clave: "Modes" / device profiles** — un modo es una configuración nombrada de settings de dispositivo; asignás varios dispositivos al mismo modo y un cambio se propaga a todos. ([Square — Create and assign modes](https://squareup.com/help/us/en/article/8114-create-and-manage-device-profiles))
- **Patrón clave #2: settings templates por tipo de servicio.** Square for Restaurants trae **3 plantillas: Table service, Counter service, Bar or lounge** — "configuraciones de settings específicas por tipo de servicio que asignás a tus dispositivos para arrancar rápido". El usuario no configura 40 toggles: elige *qué tipo de negocio es* y recibe defaults correctos. ([Square — Set up your restaurant POS](https://squareup.com/help/us/en/article/6390-create-a-device-code-for-square-for-restaurants))
- El rediseño 2024-2025 de Square POS/Dashboard se justificó explícitamente como "simplificar operaciones complejas y que negocios de cualquier tamaño se configuren rápido". ([Square — Updated POS and Dashboard](https://squareup.com/us/en/the-bottom-line/inside-square/updated-square-pos-and-square-dashboard-app))

### 1.3 Toast — separación negocio vs dispositivo, y "publish"

- Toast separa con dureza **config del restaurante (Toast Web, back-office)** vs **config del dispositivo (en el equipo: grilla del menú, área de servicio por defecto, auto-fire, lector de tarjetas)**. Dos capas de permisos paralelas: roles de POS (qué hacés en el terminal) y roles Web (qué hacés en el admin) — independientes entre sí. ([Toast — Device Setup Overview](https://support.toasttab.com/en/article/Device-Setup-Overview-1493004445768), [Permissions Reference](https://doc.toasttab.com/doc/platformguide/adminPermissions.html))
- Cambios de configuración/menú **no llegan al POS hasta que se publican** (botón Publish) — patrón borrador→publicar que evita romper el servicio en plena hora pico.
- Lección: Toast es el más potente y a la vez el más criticado por complejidad de setup — su onboarding self-service tarda ~14 días y el full-service 4-6 semanas con consultor asignado. Es el contraejemplo: potencia configurable sin defaults fuertes = dependencia de onboarding humano. ([Toast — Self-Service Onboarding Guide](https://support.toasttab.com/en/article/Self-Service-Guide))

### 1.4 Stripe — search-first y navegación mínima

- Stripe redujo deliberadamente los links del sidebar ("minimized the number of links to make it even more simple"), muestra tabs recientes y páginas pinneadas, y apuesta a **búsqueda global** que cruza clientes, invoices, payouts, productos y también páginas/settings. Atajos de teclado (`?` para la lista). ([Stripe — Dashboard basics](https://docs.stripe.com/dashboard/basics), [Dashboard update May 2024](https://support.stripe.com/questions/dashboard-update-may-2024))
- Conclusión transversal: **nadie es "search-first" puro**. El patrón ganador es **navegación por dominio clara + búsqueda global como acelerador** (no como muleta para una estructura confusa). El buscador de PASE en Ajustes está bien, pero no reemplaza una buena estructura.

### 1.5 Material Design / literatura general

- Material Design (guía clásica de settings, aún canónica): en settings va **lo que se toca poco**; lo frecuente va en la UI principal. Con **15+ settings, agrupar en sub-pantallas**. Ordenar por importancia/frecuencia, títulos de sección específicos (nunca "Otros"), labels en lenguaje del usuario, texto secundario solo si aclara el estado actual. ([Material — Settings pattern](https://m1.material.io/patterns/settings.html))
- Anti-patrones documentados en settings: opciones dispersas, categorización confusa, jerga técnica ("settings are best described in plain language that indicates functionality rather than technical or clever names"), demasiadas opciones que no afectan a la mayoría, falta de feedback al guardar. ([Toptal — Settings UX](https://www.toptal.com/designers/ux/settings-ux), [LogRocket — Designing settings screens](https://blog.logrocket.com/ux-design/designing-settings-screen-ui/))

---

## 2. Defaults y plantillas — cómo evitan el catálogo vacío Y el catálogo abrumador

Los dos extremos son fallas conocidas: pantalla vacía (usuario no sabe qué hacer) y lista de 100+ ítems precargados (usuario no encuentra nada y siente que el sistema "no es para él").

### 2.1 El patrón ganador: plantilla por tipo de negocio + lista corta editable

- **Square**: plantillas por tipo de servicio (table/counter/bar) + modos por industria (bar, quick-service, full-service, retail, belleza). Además, para el menú: 3 caminos — crear manual, **subir un menú existente (archivo/foto)**, o **generar un menú inicial con IA respondiendo preguntas básicas (tipo de cocina, tamaño)** y editarlo. ([Square — Get started with Square for Restaurants](https://squareup.com/help/us/en/article/6407-get-started-with-square-for-restaurants))
- **Toast**: el onboarding crea la cuenta "con smart defaults y settings pre-configurados", checklist distinto según quick-service vs full-service, y menú por **import asistido** (planilla template + bulk import CSV con 3 niveles: básico, update, avanzado). ([Toast — Self-Service Guide](https://support.toasttab.com/en/article/Self-Service-Guide), [Toast — Bulk import tool](https://doc.toasttab.com/doc/platformguide/platformBulkImportToolOverview.html))
- **Shopify dev guidelines**: en onboarding ofrecer 3 caminos tipo "editar lo existente / usar plantilla / arrancar de cero". ([shopify.dev — Onboarding](https://shopify.dev/docs/apps/design/user-experience/onboarding))

### 2.2 ¿62 categorías de gastos es mucho? Benchmarks de planes de cuentas

- **Xero** demo company: **69 cuentas** en TODO el plan de cuentas (activos+pasivos+patrimonio+ingresos+gastos). Y la propia guía de Xero dice que un negocio chico típico usa **20-50 cuentas en total**. ([Xero — Chart of accounts](https://central.xero.com/s/article/Chart-of-accounts-in-Xero), [Xero — Set up a chart of accounts](https://www.xero.com/us/guides/how-to-do-bookkeeping/chart-of-accounts/))
- **QuickBooks**: default genérico no restaurantero; los templates restauranteros "pro" (para contadores) llegan a 100-125 cuentas, pero agrupadas en **6 familias** (CMV, costos directos, administración, payroll, honorarios, ocupación) y pensados para el contador, no para el dueño. ([Prix Fixe — Restaurant CoA template](https://prixfixe.accountants/blog/2021/9/2/restaurant-chart-of-accounts-free-template-for-quickbooks), [QuickBooks — Understanding the chart of accounts](https://quickbooks.intuit.com/learn-support/en-us/help-article/chart-accounts/understanding-chart-accounts/L5MraHgGZ_US_en_US))
- **Lectura para PASE**: 62 categorías de gastos *solo de gastos* (más 27 de compras + 11 de ingresos) está en la zona "plan de cuentas de contador", no "categorías de dueño". Para el dueño no-técnico el número correcto día-1 es **~10-15 categorías de gastos visibles, en 5-6 familias**, con el resto disponible pero no precargado. El detalle fino se agrega cuando hace falta (ver 2.3).
- Regla práctica de la industria: **el default define el techo de adopción**. Si el día 1 hay 62 categorías, el usuario va a tirar todo a "Varios" — exactamente lo contrario de lo que el catálogo grande pretendía lograr.

### 2.3 Crear-al-usar (inline create)

- Patrón estándar en software operativo moderno (y ya usado en PASE: quick-create de insumo/MP inline, sesión 29-may): el combobox de categoría/medio de pago/puesto ofrece **"+ Crear nueva…" en el punto de uso**, sin ir a Ajustes. Esto convierte el catálogo en algo que **crece con el uso real** en vez de exigir configuración anticipada.
- Combinación ganadora: lista corta default + inline create + (opcional) sugerencias "¿querés agregar X?" cuando el sistema detecta un patrón. Así nunca hay catálogo vacío ni abrumador.

---

## 3. Onboarding día-1 — el patrón "setup checklist"

### 3.1 Anatomía del patrón (Shopify es el canon)

- **Checklist interactivo en el Home**, no en una pantalla aparte: título + botón de descartar + colapsar, **indicador de progreso ("2 de 5 pasos completados")**, pasos expandibles de a uno (acordeón que auto-abre el siguiente paso pendiente), cada paso con descripción corta orientada a beneficio + CTA directo a la pantalla correspondiente. ([shopify.dev — Setup guide pattern](https://shopify.dev/docs/api/app-home/patterns/compositions/setup-guide))
- **Los pasos se marcan completos AUTOMÁTICAMENTE** cuando el sistema detecta que se hizo la acción (no checkbox manual): "a good setup acts as a quick start with discrete steps that are automatically marked as complete". ([shopify.dev — Onboarding](https://shopify.dev/docs/apps/design/user-experience/onboarding))
- **Personalizado según el survey de signup**: Shopify pregunta al registrarse qué tipo de negocio sos y arma el checklist a medida — no one-size-fits-all. ([Candu — Shopify's personalized onboarding](https://www.candu.ai/blog/shopify-onboarding-flow))
- **Skippeable siempre**: dismiss del checklist entero + "Remind me later" en pasos largos. Nunca bloquear el producto detrás del setup.

### 3.2 Cuántos pasos

- Shopify dev guidelines: **"Avoid more than five steps"**. La literatura de activación coincide: **3-5 tareas** es el sweet spot; más pasos = más drop-off. ([shopify.dev — Onboarding](https://shopify.dev/docs/apps/design/user-experience/onboarding), [Userpilot — Onboarding checklist](https://userpilot.com/blog/user-onboarding-checklist-tips/), [Appcues — SaaS onboarding examples](https://www.appcues.com/blog/saas-user-onboarding))
- Truco psicológico documentado: **arrancar el progreso en >0%** (el registro ya cuenta como paso completado) — el efecto Zeigarnik/endowed progress hace que la gente termine lo que ve empezado. ([SaaSUI — Onboarding patterns](https://www.saasui.design/blog/saas-onboarding-ux-examples))
- Ordenar el checklist **por valor, no por lógica de sistema**: el primer paso debe ser el que produce la primera sensación de "esto funciona" (cargar 3 productos y ver el POS armado), no "completá tus datos fiscales".

### 3.3 La métrica: time-to-first-value / time-to-first-sale

- La métrica ancla en POS/pagos es **tiempo hasta la primera transacción**; el patrón de alta retención es **primer valor dentro de las 24 horas**. ([Count — Time to First Value](https://count.co/metric/time-to-first-value), [Digital Applied — TTV framework 2026](https://www.digitalapplied.com/blog/customer-onboarding-time-to-value-2026-saas-metrics-framework), [Plaid — Merchant onboarding](https://plaid.com/resources/fintech/merchant-onboarding/))
- Benchmarks de implementación POS completos: Toast self-service ~14 días, full 4-6 semanas; el mercado general 2 semanas a 1 mes. **Fudo (competencia directa argentina) comunica que el 90% de sus clientes opera en menos de una semana** y las reviews destacan "la seño de caja lo puede manejar desde el primer día". Ese es el bar local a superar. ([Toast — Self-Service Guide](https://support.toasttab.com/en/article/Self-Service-Guide), [Fudo blog — Terminal POS](https://blog.fu.do/terminal-pos-para-restaurantes-en-argentina-la-primera-pensada-100-para-gastronomia), [Capterra — Fudo](https://www.capterra.com/p/241757/FUDO/))
- Qué hace que un dueño no-técnico complete el setup solo (síntesis de las fuentes): (1) defaults que ya funcionan sin tocar nada, (2) checklist visible con progreso, (3) cada paso lleva DIRECTO a la acción (deep-link, no instrucciones), (4) poder vender ANTES de terminar el setup (lo fiscal/avanzado después), (5) import asistido del menú (planilla/foto/IA) en vez de carga manual ítem por ítem.

---

## 4. Progressive disclosure en software operativo

- Principio NN/g: mostrar primero **el set mínimo que la mayoría necesita**, y lo avanzado a un click explícito. Dos requisitos: (a) la división core/avanzado tiene que ser correcta — **todo lo frecuente tiene que estar arriba** (si no, solo mudaste la complejidad de lugar); (b) la puerta a lo avanzado tiene que ser visible y bien rotulada ("Mostrar opciones avanzadas", no un ícono misterioso). **Máximo 2 niveles de disclosure** — más de 2 niveles mide mal en usabilidad. ([NN/g — Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))
- Cómo decidir qué es "core": frecuencia de uso real (analytics/instrumentación), no opinión del que diseñó la feature. En enterprise software: capa core = mínimo para completar la tarea; capa avanzada = legítimo pero de baja frecuencia, mayor riesgo o que requiere contexto. ([UXPin — Progressive disclosure](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/), [IxDF — Progressive disclosure](https://ixdf.org/literature/topics/progressive-disclosure))
- Variante para setup: **staged disclosure** (wizard) — mostrar lo que se usa primero en la secuencia de la tarea, no lo más importante en abstracto. Funciona cuando los pasos son independientes; falla si el usuario tiene que saltar entre pasos.
- Aplicado a settings de POS: el patrón de Square/Toast es esconder lo avanzado **detrás del template**: elegís "servicio de mesa" y 40 settings quedan bien sin que los veas; los tocás solo si entrás a buscarlos. El copy tipo *"no vas a necesitar esto todavía"* aparece como microcopy de sección avanzada en los mejores productos.

---

## 5. Configuración multi-local: herencia global → override por local

- Patrón estándar de la industria (Toast MLM, Shift4, Square): **jerarquía Empresa → (Grupo) → Local**. Todo se hereda hacia abajo automáticamente; el local puede **overridear campo por campo**, y solo ese campo deja de seguir al global. ([Shift4 — Data Inheritance and Overrides](https://shift4.zendesk.com/hc/en-us/articles/37650032199187-Manage-Data-Inheritance-and-Overrides-in-Multi-Location-Management), [Toast — Menu manager multi-location](https://doc.toasttab.com/doc/platformguide/platformMenuManagerMenuAndMultiLocationRestaurants.html))
- **Cómo lo presentan sin confundir** (las 3 claves):
  1. **Indicador visual por campo**: campo heredado = gris/normal; campo overrideado = marcado (punto azul / chip "personalizado en este local") + botón **Reset a global**. Toast usa el mismo lenguaje en permisos: checkbox gris = heredado del rol, azul = override individual. ([Toast — MLM Permissions](https://support.toasttab.com/en/article/MLM-Permissions-Guide))
  2. **Contadores hacia arriba**: en la vista global, cada entidad muestra "3 locales con overrides" para que el admin sepa dónde se desvió la realidad.
  3. **Detalle sutil pero importante**: si el local pone el mismo valor que el global, **sigue siendo override** hasta que aprieta Reset — porque la intención ("quiero que esto deje de seguir al global") importa más que el valor.
- Anti-confusión: siempre dejar claro **desde dónde estás editando** ("Estás editando: Todos los locales" vs "Estás editando: Sucursal Centro") — la mayoría de los errores multi-local reportados son por editar en el nivel equivocado sin darse cuenta.

---

## 6. Anti-patrones documentados (checklist de lo que NO hacer)

1. **Settings dispersos en N pantallas** sin un índice único — el usuario no sabe si lo que busca está en Ajustes, en el módulo, o en el dispositivo. ([Toptal — Settings UX](https://www.toptal.com/designers/ux/settings-ux))
2. **Jerga interna / nombres de sistema** en labels ("Medios de cobro" vs lo que el dueño llama "formas de pago"; slugs visibles como `eerr`). Plain language siempre. ([LogRocket](https://blog.logrocket.com/ux-design/designing-settings-screen-ui/))
3. **Listas planas de 100+ items** sin familias ni jerarquía visual — Material manda sub-agrupar a partir de ~15. ([Material — Settings](https://m1.material.io/patterns/settings.html))
4. **Configuración requerida antes de ver valor** — el pecado capital. Stripe deja integrar todo en test mode con datos de ejemplo antes de activar nada real; el POS debería dejar "vender" de prueba antes de tener CUIT cargado. ([Appcues](https://www.appcues.com/blog/saas-user-onboarding))
5. **Settings que afectan a casi nadie ocupando espacio de primer nivel** — la regla: un setting visible debe afectar a la mayoría o ser crítico para una minoría; el resto va a "avanzado". ([Material](https://m1.material.io/patterns/settings.html))
6. **Más de 5 pasos de onboarding / checklist sin escape** — drop-off garantizado. ([shopify.dev — Onboarding](https://shopify.dev/docs/apps/design/user-experience/onboarding))
7. **Más de 2 niveles de progressive disclosure** — NN/g lo marca como falla de usabilidad medible. ([NN/g](https://www.nngroup.com/articles/progressive-disclosure/))
8. **Sin feedback al guardar / sin protección de cambios sin guardar** — Shopify lo resuelve con save bar + toast. ([shopify.dev — Settings](https://shopify.dev/docs/api/app-home/patterns/templates/settings))

---

## 7. Empty states y primeros 5 minutos

- Tres tipos canónicos: **informativo** (por qué está vacío), **accionable** (CTA que lo llena — el que importa acá), **celebratorio** (inbox-zero). Anatomía: titular + 1 línea de explicación + CTA grande; ilustración opcional. ([Pencil & Paper — Empty states](https://www.pencilandpaper.io/articles/empty-states), [Carbon Design System — Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/))
- El dato que justifica la inversión: el empty state aparece en el momento de máxima incertidumbre; el 80% del churn pre-activación ocurre la primera semana, y mejorar empty states mueve activación de ~25-30% a 40%+. ([SaaS Factor — Empty state UX](https://www.saasfactor.co/blogs/empty-state-ux-turn-blank-screens-into-higher-activation-and-saas-revenue), [Userpilot — Empty state SaaS](https://userpilot.com/blog/empty-state-saas/))
- Ejemplos de referencia: **Webflow** pone un único CTA gigante con todo lo demás atenuado (cero decisiones); **Notion** llena el vacío con contenido educativo que funciona de demo+checklist; **Monday** muestra un board demo con datos realistas antes de que cargues nada; **Stripe** precarga el dashboard de test mode con cargos/clientes de ejemplo. ([Eleken — Empty state UX](https://www.eleken.co/blog-posts/empty-state-ux), [Product Fruits — B2B SaaS onboarding](https://productfruits.com/blog/b2b-saas-onboarding))
- Para datos demo, regla: banner explícito "Estos son datos de ejemplo para que veas cómo se ve" + un click para borrarlos. La alternativa (mejor para POS): que la plantilla por tipo de negocio genere un **menú inicial real-editable**, como hace Square con su starter menu por IA — datos "casi reales" que el usuario corrige en vez de crear.

---

## 8. Evaluación del modelo actual de Ajustes de PASE

**Lo que hoy es Ajustes**: buscador global + 6 secciones colapsables de catálogos — Categorías de gastos (62), Categorías de compras (27), Categorías de ingresos (11), Medios de cobro (23), Puestos (10), Turnos (0). Total 151 items.

| Patrón de la industria | PASE hoy | Veredicto |
|---|---|---|
| Settings = baja frecuencia; catálogos vivos = navegación propia | Ajustes ES un editor de catálogos | ❌ Confusión conceptual: es una pantalla de "datos maestros" llamada Ajustes |
| Agrupar por dominio, sub-agrupar a partir de ~15 items | 62 items planos dentro de una sección colapsable | ❌ Lista plana del triple del umbral |
| Defaults cortos + plantilla por tipo de negocio | 151 items precargados iguales para todos | ❌ "Catálogo abrumador": el peor de los dos extremos junto con Turnos (0) que es "catálogo vacío" |
| Búsqueda como acelerador | Buscador global ✓ | ✅ Correcto, mantener |
| Inline create en punto de uso | Ya existe en insumos/MP | 🟡 Extender a categorías/medios/puestos |
| Herencia global→local con override visible | (multi-local existe en PASE, sin patrón formal de override en ajustes) | 🟡 Definir el patrón antes de que escale |
| Setup checklist en Home con progreso y auto-complete | Wizard /onboarding de 5 pasos (27-may) existe, pero es wizard-aparte, no checklist persistente en Inicio | 🟡 Base buena, falta convertirlo al patrón canon |
| Config dispositivo vs config negocio separadas | COMANDA y PASE comparten config sin esa distinción explícita | 🟡 Relevante para el piloto COMANDA |

**Diagnóstico en una frase**: el problema de PASE no es que falte un buscador ni que las secciones colapsen — es que **Ajustes mezcla dos cosas distintas (preferencias del sistema y datos maestros del negocio) y resuelve los datos maestros con el anti-patrón de lista plana precargada de 151 items**, cuando el estándar de la industria es plantilla corta por tipo de negocio + crecer con el uso.

---

## 9. Recomendación concreta

### 9.1 Reestructurar Ajustes (el modelo objetivo)

1. **Separar en dos mundos con nombres distintos**:
   - **"Mi negocio"** (datos maestros vivos): categorías de gastos/compras/ingresos, medios de cobro, puestos, turnos, locales. Cada catálogo con su propia sub-página (no acordeón), contador de uso ("usada en 340 gastos"), y agrupado en familias.
   - **"Ajustes"** (preferencias reales del sistema): notificaciones, seguridad/auto-lock, preferencias de POS, impresoras, usuarios y permisos, integraciones. Páginas angostas, secciones temáticas, ayuda contextual al lado de cada control (patrón Shopify).
2. **Reducir los defaults a escala dueño, no contador**: ~12-15 categorías de gastos visibles organizadas en 5-6 familias (Mercadería/CMV, Personal, Alquiler y servicios, Operación, Impuestos y bancos, Otros), ~8-10 de compras, ~6 de ingresos, ~8 medios de cobro. El resto del catálogo actual pasa a ser **"sugerencias activables"** (lista de "agregar desde catálogo PASE" con un click) — así no se pierde el trabajo hecho, se re-empaqueta como biblioteca opcional. Benchmark: Xero default total = 69 cuentas *para todo el plan contable*; un negocio chico usa 20-50.
3. **Inline create en todos los catálogos**: todo combobox de categoría/medio/puesto con "+ Crear nueva" (patrón ya probado en insumos). El catálogo crece con el uso, no por configuración anticipada.
4. **Progressive disclosure de 2 niveles exactos**: cada catálogo muestra "las que usás" arriba; "Ver todas / opciones avanzadas" abajo, con label explícito. Microcopy "Probablemente no necesites esto todavía" en lo avanzado.
5. **Multi-local**: adoptar el patrón herencia+override con los 3 elementos (indicador por campo overrideado + Reset a global + contador "N locales personalizados" en la vista global) y banner permanente de contexto "Editando: todos los locales / Sucursal X".
6. **Para COMANDA**: distinguir explícitamente "configuración del local" (en PASE/admin) vs "configuración de este aparato" (en el dispositivo), como Toast/Square. Y considerar **plantillas de servicio** (mostrador / mesas / barra) que setean en bloque los ~15 toggles de comportamiento del POS.

### 9.2 Onboarding día-1 (el modelo objetivo)

1. **Pregunta única al crear el tenant**: "¿Qué tipo de negocio es?" (café/panadería · bar · restaurante con mesas · take-away/delivery). Esa respuesta elige la plantilla: categorías default, medios de cobro típicos, turnos sugeridos, modo de POS, y personaliza el checklist (patrón Shopify de survey→checklist).
2. **Convertir el wizard /onboarding existente en un setup checklist persistente en Inicio**: colapsable, descartable, progreso visible que arranca en ~20% ("Cuenta creada ✓"), **máximo 5 pasos**, cada paso deep-linkea a la acción y **se marca completo solo** cuando el sistema detecta el dato (ya hay infraestructura: `fn_onboarding_completar_paso`).
3. **Los 5 pasos ordenados por valor, no por lógica de sistema**: ① Cargá tu carta (con import asistido: planilla simple o foto del menú — gap clave vs carga manual; Square ya genera starter menu con IA) → ② Hacé una venta de prueba (sandbox, sin caja real) → ③ Configurá tus medios de cobro reales → ④ Sumá a tu equipo (PINs) → ⑤ Abrí tu primera caja real.
4. **Métrica norte: primera venta real en <24 h desde el alta**, y "manejable por la cajera el día 1" — el benchmark local es Fudo ("90% operando en menos de una semana"); el objetivo de PASE+COMANDA debería ser **operando el mismo día**.
5. **Empty states accionables en cada pantalla núcleo** (ventas, gastos, equipo, stock): titular + 1 línea + CTA único grande; nunca tabla vacía muda. La venta de prueba del paso ② hace además de "demo data" sin ensuciar datos reales.
6. **Nunca bloquear por configuración**: lo fiscal (ARCA/CAE cuando llegue), impresoras y stock se configuran *después* de la primera venta, no antes. Skippeable todo, recordatorios suaves.

### 9.3 Prioridad sugerida (impacto/esfuerzo, pre-piloto)

1. **Recorte de defaults + familias** en los catálogos (alto impacto, bajo esfuerzo — es data + UI de agrupado).
2. **Checklist en Inicio** reciclando el wizard existente (alto impacto, esfuerzo medio).
3. **Inline create** en categorías/medios/puestos (impacto medio, bajo esfuerzo — patrón ya existe).
4. Separación "Mi negocio" vs "Ajustes" (estructural, hacerlo antes de que crezcan más settings).
5. Plantillas de servicio COMANDA + patrón override multi-local (post-piloto, cuando haya 2º tenant multi-local real).

---

## Fuentes principales

- Shopify: [Settings pattern](https://shopify.dev/docs/api/app-home/patterns/templates/settings) · [Setup guide pattern](https://shopify.dev/docs/api/app-home/patterns/compositions/setup-guide) · [Onboarding guidelines](https://shopify.dev/docs/apps/design/user-experience/onboarding) · [App design](https://shopify.dev/docs/apps/design) · [Help — Settings](https://help.shopify.com/en/manual/your-account/account-settings) · [Candu — Shopify personalized onboarding](https://www.candu.ai/blog/shopify-onboarding-flow)
- Square: [Settings templates / restaurant POS setup](https://squareup.com/help/us/en/article/6390-create-a-device-code-for-square-for-restaurants) · [Modes/device profiles](https://squareup.com/help/us/en/article/8114-create-and-manage-device-profiles) · [Get started with Square for Restaurants](https://squareup.com/help/us/en/article/6407-get-started-with-square-for-restaurants) · [Account & settings](https://squareup.com/help/us/en/subtopic/dashboard-account-settings) · [Updated POS & Dashboard](https://squareup.com/us/en/the-bottom-line/inside-square/updated-square-pos-and-square-dashboard-app)
- Toast: [Self-Service Onboarding Guide](https://support.toasttab.com/en/article/Self-Service-Guide) · [Device Setup Overview](https://support.toasttab.com/en/article/Device-Setup-Overview-1493004445768) · [Bulk import](https://doc.toasttab.com/doc/platformguide/platformBulkImportToolOverview.html) · [MLM Permissions](https://support.toasttab.com/en/article/MLM-Permissions-Guide) · [Menu manager multi-location](https://doc.toasttab.com/doc/platformguide/platformMenuManagerMenuAndMultiLocationRestaurants.html)
- Stripe: [Dashboard basics](https://docs.stripe.com/dashboard/basics) · [Dashboard update May 2024](https://support.stripe.com/questions/dashboard-update-may-2024)
- Multi-local: [Shift4 — Inheritance & Overrides](https://shift4.zendesk.com/hc/en-us/articles/37650032199187-Manage-Data-Inheritance-and-Overrides-in-Multi-Location-Management)
- Literatura UX: [NN/g — Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) · [Material — Settings](https://m1.material.io/patterns/settings.html) · [Toptal — Settings UX](https://www.toptal.com/designers/ux/settings-ux) · [LogRocket — Settings screens](https://blog.logrocket.com/ux-design/designing-settings-screen-ui/) · [Pencil & Paper — Empty states](https://www.pencilandpaper.io/articles/empty-states) · [Userpilot — Checklists](https://userpilot.com/blog/user-onboarding-checklist-tips/) · [Appcues — SaaS onboarding](https://www.appcues.com/blog/saas-user-onboarding) · [SaaS Factor — Empty state UX](https://www.saasfactor.co/blogs/empty-state-ux-turn-blank-screens-into-higher-activation-and-saas-revenue)
- Contabilidad: [Xero — Chart of accounts](https://central.xero.com/s/article/Chart-of-accounts-in-Xero) · [Xero — How to set up a CoA](https://www.xero.com/us/guides/how-to-do-bookkeeping/chart-of-accounts/) · [Prix Fixe — Restaurant CoA](https://prixfixe.accountants/blog/2021/9/2/restaurant-chart-of-accounts-free-template-for-quickbooks)
- Competencia local: [Fudo blog](https://blog.fu.do/terminal-pos-para-restaurantes-en-argentina-la-primera-pensada-100-para-gastronomia) · [Capterra — Fudo](https://www.capterra.com/p/241757/FUDO/)
- Métricas: [Count — TTFV](https://count.co/metric/time-to-first-value) · [Digital Applied — TTV 2026](https://www.digitalapplied.com/blog/customer-onboarding-time-to-value-2026-saas-metrics-framework)
