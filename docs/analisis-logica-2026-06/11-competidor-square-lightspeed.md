# Análisis de competidores: Square for Restaurants, Lightspeed Restaurant y TouchBistro

**Fecha:** 11-jun-2026 · **Foco:** lógica de funcionamiento, modelos mentales y decisiones de UX (NO features ni precios)
**Para:** PASE+COMANDA — el objetivo es entender por qué Square es el referente mundial de "lo entendés el día 1 sin manual", y qué hacen bien/mal Lightspeed y TouchBistro en servicio de mesa.

> Metodología: docs oficiales (squareup.com/help, k-series-support.lightspeedhq.com, touchbistro.com/help), reviews independientes (Merchant Maverick, FitSmallBusiness, Capterra, G2, tech.co), foros de usuarios (Square Community, Trustpilot) y análisis de consultores POS (Certus AI, Owner.com, TheRestaurantHQ). Cada afirmación lleva su fuente.

---

## 1. Por qué Square es tan fácil el día 1

La facilidad de Square no es magia: es una serie de **decisiones concretas y acumulativas** de diseño de producto.

### 1.1 Filosofía raíz: sustracción, no adición

La cultura de diseño de Square viene de los tres principios fundacionales de Jack Dorsey: **simplicidad, restricción y artesanía** ([Creative Mastery](https://www.creativemastery.blog/p/jack-dorsey), [Fast Company](https://www.fastcompany.com/3004037/solving-problems-square-way)). El modelo interno trata **cada feature agregada como un impuesto sobre lo que ya existe** — la pregunta default no es "¿qué agregamos?" sino "¿qué sacamos?". El producto original (lector cuadrado en el jack de auriculares) ya encarnaba esto: cualquiera acepta tarjetas con setup mínimo, sin banco, sin contrato, sin técnico ([Frederick.ai](https://www.frederick.ai/blog/jack-dorsey-square)).

**Implicancia de producto**: Square prefiere que el 80% de los usuarios tenga una experiencia perfecta antes que el 100% tenga una experiencia mediocre pero completa. El 20% restante (full-service complejo) lo pierde conscientemente contra Toast.

### 1.2 Decisiones concretas que producen el "día 1 sin manual"

1. **Setup 100% self-service, sin vendedor ni técnico.** El onboarding son 5 pasos lineales: elegir hardware → verificar identidad y vincular banco → crear el menú → configurar el dispositivo → bajar la app y vender ([Square Help — Get started with Square for Restaurants](https://squareup.com/help/us/en/article/6407-get-started-with-square-for-restaurants)). Merchant Maverick lo resume: "no se necesita representante; setup rápido e intuitivo de hardware y software" ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).

2. **Settings templates por tipo de servicio.** En vez de 50 toggles, Square ofrece **3 plantillas de configuración**: *Table service*, *Counter service* y *Bar or lounge*. Elegís una y el dispositivo queda configurado con defaults sensatos para ese modo (propina automática por tamaño de mesa, "straight fire categories" que mandan bebidas directo a la barra, asignación de propinas al que abre o cierra el check) ([Square Help — Set up your restaurants POS](https://squareup.com/help/us/en/article/6390-create-a-device-code-for-square-for-restaurants)). **Este es quizás el patrón más copiable**: la pregunta de setup no es "configurá 30 settings" sino "¿qué tipo de local sos?" — y todo lo demás se deriva.

3. **Device codes en vez de login con email.** Para enchufar una caja nueva no hay que crear cuentas: se genera un **código de 12 dígitos** en el Dashboard, se tipea en el iPad y la caja queda logueada y operativa. Los empleados después entran con su PIN de 4 dígitos ([Square Help](https://squareup.com/help/us/en/article/6390-create-a-device-code-for-square-for-restaurants)). Separa limpiamente "identidad del dispositivo" de "identidad del empleado".

4. **Progresión automática por modifiers requeridos.** Al tocar un ítem con modifier sets obligatorios, el POS **avanza solo de arriba hacia abajo** por cada set requerido hasta completarlos todos — el mozo no tiene que saber qué falta, la UI lo lleva ([Square Help — Modifiers](https://squareup.com/help/us/en/article/6426-modifiers-and-categories-with-square-for-restaurants)). El flujo es un wizard implícito, no un formulario.

5. **Hardware plug-and-play literal.** Square Terminal: encender, conectar a Wi-Fi, loguear — **menos de 10 minutos**, sin técnico ni cableado ([POS USA — Square Terminal Review](https://www.posusa.com/square-terminal-review/), [Robot Dragon Studios](https://robotdragon.studio/blogs/news/product-review-square-terminal)). La cuenta en sí toma menos de 5 minutos ([LitExtension](https://litextension.com/blog/how-to-set-up-square/)).

6. **Terminología simple y de negocio, no de software.** "Items", "Menus", "Checkout", "Favorites". Sin jerga ("SKU matrix", "price levels", "revenue centers"). Los productos están hechos "pensando en el cliente, para que incluso gente que no es buena con la tecnología pueda usarlos" ([The New Economy](https://www.theneweconomy.com/i40-content/jack-dorsey-square)).

7. **Entrenamiento de staff casi nulo.** Merchant Maverick: "Cualquiera que haya trabajado en gastronomía encuentra la interfaz increíblemente intuitiva… los managers se asombran de lo simple que fue entrenar empleados completamente nuevos, ahorrando incontables horas" ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)). Certus AI: el staff lo aprende **en una hora** ([Certus AI](https://www.certus-ai.com/blogs/toast-vs-square-for-restaurants-which-pos-is-better-for-independents)).

8. **Empatía institucionalizada.** El onboarding interno de empleados de Square for Restaurants los obliga a **vivir el camino del cliente**: armar un menú desde cero como si fueran un restaurante nuevo, con el vocabulario gastronómico explicado en contexto ([Figma — caso Square](https://www.figma.com/customers/square/)). La empresa entera se entrena en "pensar como un usuario nuevo".

### 1.3 Cómo logra que un local venda en 1 hora (la secuencia real)

Cuenta (5 min) → menú importado o manual (15-30 min; ver §7) → device code en el iPad (2 min) → settings template según tipo de local (5 min) → hardware enchufado (10 min) → **vendiendo**. Ningún paso requiere humano de Square. El procesamiento de pagos viene integrado y pre-aprobado (no hay trámite bancario aparte), que históricamente era el cuello de botella de cualquier POS.

---

## 2. El modelo de catálogo de Square

### 2.1 Los tres conceptos: Item → Variations → Modifiers

- **Item**: el producto base ("Hamburguesa").
- **Variations**: formas **fijas y excluyentes** del ítem, con precio propio y **stock propio** ("Simple / Doble / Triple"). Regla mental: *si necesitás contar inventario por separado o es una elección estructural del producto, es variation* ([Square Community — Variations vs Modifiers](https://community.squareup.com/t5/Orders-Menu-Items-Catalog/Using-Variations-vs-Modifiers/m-p/374623)).
- **Modifiers**: personalizaciones **en el momento de la venta**, agrupadas en *modifier sets* reutilizables entre ítems, con o sin precio, sin stock ("sin cheddar", "+palta"). Pueden ser requeridos (con mínimo/máximo de selecciones) u opcionales, y desde 2024-25 se pueden **anidar** (elegir masa → elegir relleno de esa masa) ([Square Help — Modifiers](https://squareup.com/help/us/en/article/5119-create-and-manage-item-modifiers), [Square Developer — Modifiers](https://developer.squareup.com/docs/catalog-api/enable-modifiers-on-items)).
- **Item Options** (capa de conveniencia): definís ejes ("Tamaño: S/M/L", "Color") y Square **genera automáticamente una variation por cada combinación**, sin tipearlas a mano ([Square Developer — Item Options](https://developer.squareup.com/docs/catalog-api/item-options)).

Ejemplo canónico de la comunidad: el combo de hamburguesa viene S/M/L → **variations** (precio y stock fijos); sacarle el queso o sumarle palta → **modifiers** ([Lil Engine](https://www.lilengine.co/articles/variants-vs-modifier-sets-optimizing-square-your-cafe)).

### 2.2 La capa de presentación: Categories vs Menu Groups (separación clave)

Square separa **taxonomía contable** de **layout visual**:
- **Categories** = reporting y ruteo de impresión (qué impresora/KDS recibe el ítem).
- **Menu groups** = cómo se ve la grilla del POS: color, tamaño de tile, posición, páginas. "Los menu groups son designaciones separadas de las categorías, lo que permite personalizar el layout del menú **sin afectar reportes ni ruteo de impresoras**" ([Square Help — Menu groups y layout](https://squareup.com/help/us/en/article/7804-organize-your-menu-with-square-for-restaurants)).

El POS muestra una grilla de tiles editable: drag & drop, auto-ajuste de tamaño, páginas múltiples, tiles de "funciones" (descuento, búsqueda) mezclados con ítems, y una pantalla *Favorites* donde se fija lo más vendido ([Square Help](https://squareup.com/help/us/en/article/7804-organize-your-menu-with-square-for-restaurants), [Square Community](https://community.squareup.com/t5/Orders-Menu-Items-Catalog/How-do-I-rearrange-the-tiles-on-my-Restaurants-POS-layout/td-p/772547)).

### 2.3 Menús por ubicación y canal (multi-channel desde un solo catálogo)

Un **Menu** es un subconjunto del catálogo asignable a **ubicaciones** (uno o varios locales) y **canales**: POS, sitio de pedidos online, kiosko, perfil de negocio, y apps de delivery (DoorDash, Uber Eats) — todo desde un solo lugar, con visibilidad por canal por ítem ([Square Help — Manage your menus across locations and sales channels](https://squareup.com/help/us/en/article/8553-manage-your-menus-across-locations-and-sales-channels)). Regla simple: *para que un ítem aparezca en cualquier canal de cara al cliente, tiene que estar en un menú*. Un local con menú de mañana y de noche tiene dos menús, espejando los menús físicos ([Square Help](https://squareup.com/help/us/en/article/6424-create-menus-with-square-for-restaurants)).

### 2.4 Square vs Toast: el trade-off elegido

| Dimensión | Square | Toast |
|---|---|---|
| Modelo mental | Catálogo de productos (heredado de retail) con capa de menú encima | Menú de restaurante nativo: menus → groups → items con price levels, time-based menus, revenue centers |
| Profundidad de modifiers | Sets planos + anidado básico reciente | Modifiers multinivel profundos, reglas por canal, defaults por porción (extra/lado/poco) |
| Inventario | Cantidades y costos por variation — "está bien para un café, limitante para un full-service" | Recipe costing, ingredientes, vendors ([Certus AI](https://www.certus-ai.com/blogs/toast-vs-square-for-restaurants-which-pos-is-better-for-independents)) |
| Operador típico | Café, food truck, contador, híbrido retail+comida; "setup speed y costo bajo mandan" | "Menús de 120+ ítems con modifiers complejos, segunda o tercera ubicación, salones full-service" ([Certus AI](https://www.certus-ai.com/blogs/toast-vs-square-for-restaurants-which-pos-is-better-for-independents)) |

**Dónde le queda chico a un full-service**: (a) inventario sin nivel ingrediente/receta → CMV real imposible sin terceros ([Square Community — reviews](https://community.squareup.com/t5/Square-for-Restaurants/Square-for-Restaurant-reviews/td-p/717913)); (b) coursing y features avanzadas de mesa detrás del plan pago ([Aplos AI](https://aplosai.com/blog/square-vs-toast)); (c) KDS como add-on pago — señal de que la cocina no era parte del modelo mental original ([Certus AI](https://www.certus-ai.com/blogs/toast-vs-square-for-restaurants-which-pos-is-better-for-independents)); (d) el flujo full-service de Toast (secciones, mesas, tabs de barra, coursing, ruteo KDS) "no es un add-on, es el producto core" — en Square es una capa agregada sobre un POS de mostrador ([Owner.com](https://www.owner.com/blog/toast-vs-square)).

---

## 3. El Dashboard de Square (back-office)

### 3.1 Organización

- **Un solo back-office para todo** (pagos, ítems, equipo, reportes, banca): web + app mobile espejo. La app Dashboard se posiciona como "la oficina detrás del mostrador": performance en vivo, banca, staff, desde el teléfono ([Square — Updated POS and Dashboard](https://squareup.com/us/en/the-bottom-line/inside-square/updated-square-pos-and-square-dashboard-app)).
- **Navegación por dominios de negocio**, no por módulos de software: Home (KPIs del día), Items & Orders, Payments, Customers, Staff, Reports, Settings. Los datos están **conectados entre secciones**: agregar un cliente al Directory alimenta automáticamente sus tendencias de compra en reportes ([Jotform — Square Dashboard](https://www.jotform.com/blog/square-dashboard/)).
- **Settings > Device management** concentra la configuración de comportamiento de los POS (las settings templates de §1.2 viven ahí), separando "configuración del negocio" de "configuración del dispositivo" ([Square Help](https://squareup.com/help/us/en/article/6390-create-a-device-code-for-square-for-restaurants)).

### 3.2 Patrones anti-abrumamiento

1. **Defaults primero, ajuste después**: la guía oficial sugiere arrancar con la configuración default e ir afinando "a medida que conocés los patrones de tu negocio" ([FanRuan](https://www.fanruan.com/en/blog/square-dashboard)). Nada bloquea la primera venta.
2. **Setup guide / checklist** al crear la cuenta: lista de tareas ordenada (verificar identidad, vincular banco, crear ítems, pedir hardware) en el Dashboard, cada una opcional y reanudable ([Square Help — Get Started Guide](https://squareup.com/help/us/en/article/5123-square-get-started-guide), [Page Flows — onboarding Square, 45 screenshots](https://pageflows.com/post/desktop-web/onboarding/square/)).
3. **Reportes en capas**: el plan free trae el resumen de ventas básico; los reportes profundos (ventas por sección del salón, costo laboral, live sales) aparecen solo en planes pagos — progressive disclosure comercial que además simplifica la UI del usuario chico ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).
4. **Riesgo a copiar con cuidado**: el rediseño 2024-25 del Dashboard movió secciones (p.ej. ítems de Square Online a Items) y generó quejas de usuarios desorientados — "los cambios de navegación tuvieron más impacto en el mundo real del que se anticipó" ([Square Community](https://community.squareup.com/t5/Reports-Setup-Management/Web-interface-dashboard-has-changed-can-we-change-it-back/m-p/821170)). Lección: la simplicidad de Square depende de la **estabilidad espacial**; cuando la rompen, pagan el costo.

---

## 4. El flujo del POS de Square

### 4.1 Venta de mostrador (su terreno natural)

Tap en el tile del ítem → (auto-avance por modifiers requeridos) → Review → Charge → pantalla de propina/recibo del cliente. **2-4 taps por venta simple.** Favorites para lo más vendido, páginas por grupo de menú con color ([Square Help](https://squareup.com/help/us/en/article/7804-organize-your-menu-with-square-for-restaurants)).

### 4.2 Servicio de mesa

- **Open checks**: abrir cuenta por mesa o por nombre, agregar ítems en visitas sucesivas, reabrir checks cerrados (plan pago) ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).
- **Floor plan**: editor drag & drop de mesas con **timers con código de color** que muestran estado de la mesa de un vistazo ([Square Help — Create a floor plan](https://squareup.com/help/us/en/article/6427-building-your-floor-plan), [Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).
- **Seating**: asignar ítems por asiento para que "el plato llegue a la persona correcta" y facilitar el split ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).
- **Coursing (hold & fire)**: en el carrito se agrupan ítems por curso; cada curso tiene un ícono de fuego (enviar) o pausa (retener); "Send" manda solo lo disparado; reentrar al check y tocar el fuego dispara el curso retenido, imprimiendo un "fire ticket" en cocina ([Square Help — Coursing](https://squareup.com/help/us/en/article/8172-hold-and-fire-courses-with-square-kds-and-square-for-restaurants)). Solo en planes Plus/Premium.
- **Split**: por ítem, por asiento, partes iguales, y split tender (varias tarjetas + efectivo) — los reviewers destacan los "walkthroughs fáciles para modifiers y división de cuentas" ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).
- **Bar tabs con preautorización**: abrir tab deslizando la tarjeta, hold temporal (~36 hs), cobro al cierre sin tarjeta presente; mínimos configurables $1.01–$250; disponible incluso en plan Free ([Square Help — Preauthorize payments](https://squareup.com/help/us/en/article/8455-enable-and-configure-preauthorization-for-bar-tabs)).

### 4.3 Dónde se queda corto para mesas (consenso de fuentes)

- "Square carece de workflows avanzados de coursing y gestión de mesas; es mejor para counter service" — el coursing está detrás del paywall mientras Toast lo da en todos los planes ([Aplos AI](https://aplosai.com/blog/square-vs-toast), [TheRestaurantHQ](https://www.therestauranthq.com/technology/toast-vs-square/)).
- Usuarios reales en la comunidad: "el software es buggy y lento… funciona mejor para table service que para counter en nuestra experiencia, se siente restrictivo con workflows incómodos"; Auto-86 y "busy mode" fallan; el cajón a veces no abre; soporte "atroz" ([Square Community — Constant Issues](https://community.squareup.com/t5/Square-for-Restaurants/Constant-Issues-with-Square-for-Restaurants/td-p/353102)).
- "La experiencia del día a día usando online ordering de Square + salón al mismo tiempo es desafiante" ([Capterra — Square for Restaurants reviews](https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/)).
- Sin internet queda muy limitado: offline mode procesa pagos básicos pero el sistema cloud "no es confiable sin una conexión sólida" ([Square Community](https://community.squareup.com/t5/Square-for-Restaurants/Square-for-Restaurant-reviews/td-p/717913)).

---

## 5. Lightspeed Restaurant: la lógica de salón

### 5.1 Cómo funciona su modelo de salón (K-Series)

- **Floor plans múltiples** que reflejan el local físico (salón, terraza, barra) o agrupaciones lógicas; cada mesa tiene posición, número, tamaño, **cantidad de asientos** y visibilidad configurables desde el Back Office ([Lightspeed K-Series — About floor plans](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260804656689-About-floor-plans-and-tables)).
- La pantalla *Tables* muestra en tiempo real qué mesas están libres, ocupadas, esperando pedido, servidas o por limpiar; mover mesas, unir grupos y dividir cuentas con gestos touch ([Lightspeed — Understanding the Tables screen](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050328494-Understanding-the-Tables-screen), [Softabase review](https://softabase.com/software/restaurant-management/lightspeed-restaurant)).
- **Covers (comensales) como primitiva**: al abrir la mesa se ingresan los cubiertos; eso alimenta el split en partes iguales y las métricas por comensal (ticket promedio por cubierto) ([Lightspeed — Adding orders in Table Service mode](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360051089273-Adding-orders-in-Table-Service-mode)).
- **Seats + courses como dimensiones del ítem**: cada ítem se asigna a un asiento, se comparte entre la mesa, y/o se asigna a un curso; los asientos definidos en Back Office habilitan split por asiento en el POS ([Lightspeed](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360051089273-Adding-orders-in-Table-Service-mode)).
- "Send – x ítems" como acción explícita que despacha a los *production centers* (impresoras/KDS según configuración) ([Lightspeed — Placing basic orders](https://k-series-support.lightspeedhq.com/hc/en-us/articles/360050308894-Placing-basic-orders)).
- Reviews: "editor visual de floor plan con estado en tiempo real… el table management rivaliza con plataformas dedicadas como OpenTable" ([Softabase](https://softabase.com/software/restaurant-management/lightspeed-restaurant)). Inventario **a nivel ingrediente** nativo: vender la hamburguesa descuenta pan, medallón, lechuga ([TheRealBarman](https://therealbarman.com/lightspeed-pos-review/)). Sigue agregando profundidad de salón (table pacing, checklists digitales, reservas nativas en 2026) ([Lightspeed — What's new March 2026](https://k-series-support.lightspeedhq.com/hc/en-us/articles/47746434645275-What-s-new-March-2026-Table-pacing-digital-checklists-reservations-and-more)).

### 5.2 Por qué pierde contra Toast/Square en USA

1. **Back Office pesado antes de la primera venta**: "hay MUCHO que configurar antes de usar el POS: menú, cuentas de staff, descuentos, settings de recibos, grupos de IVA, layout de botones…" ([MobileTransaction](https://www.mobiletransaction.org/lightspeed-restaurant-pos-review/)). Onboarding mayormente self-service pero con soporte lento ("1-2 días por email, una sola llamada") → "curva de aprendizaje muy alta" ([Capterra — Lightspeed reviews](https://www.capterra.com/p/211849/Lightspeed-Resturant/reviews/)). Exactamente lo opuesto a Square.
2. **Frankenstein de adquisiciones**: el producto restaurant es la fusión de iKentoo (K-Series), Gastrofix (G), Kounta (O), Upserve (U) — 4 POS distintos comprados entre 2019-2020, cada uno con su serie, su documentación y su UX ([Beehexa — 12 acquisitions](https://www.beehexa.com/blog/12-lightspeed-acquisitions-that-you-do-not-know/), [BetaKit](https://betakit.com/culmination-of-acquisitions-lightspeed-brings-revamped-restaurant-platform-to-north-america/)). Un comprador nuevo ni sabe qué "Lightspeed Restaurant" le están vendiendo. La deuda de marca y de producto es estructural.
3. **Números que lo confirman**: guidance FY2026 de 12% de crecimiento en un mercado que crece 13.3% = pierde share; sube gasto de marketing mientras pierde locaciones netas = CAC alto y/o churn elevado ([Investing.com](https://www.investing.com/analysis/lightspeed-commerce-payments-growth-cant-offset-software-stagnation-200677306)). Comparado: "Lightspeed Restaurant se cae por usabilidad pobre y precio inicial alto" frente a Square (28% de share) y Toast (24.5%) ([ExpertMarket](https://www.expertmarket.com/pos/square-vs-toast-vs-lightspeed), [6sense](https://6sense.com/tech/pos-systems/lightspeed-restaurant-market-share)).
4. Fricciones menores que suman: solo iPad, contrato anual, KDS US$30/pantalla extra, reportes de cierre de caja "extremadamente confusos" según usuarios ([Softabase](https://softabase.com/software/restaurant-management/lightspeed-restaurant), [Capterra](https://www.capterra.com/p/211849/Lightspeed-Resturant/reviews/)).

**Síntesis**: Lightspeed demuestra que tener el mejor floor plan no alcanza si el costo de llegar a usarlo es alto. El salón es su fortaleza técnica; el onboarding y la coherencia de producto son su talón de Aquiles.

---

## 6. TouchBistro: UX de servicio en mesa "por gente de restaurantes"

### 6.1 Origen que explica el diseño

Nació en 2010 de un problema físico real: un restaurante de sushi en el Caribe donde los mozos corrían adentro-afuera entre el patio y la barra de sushi, matando los tiempos de servicio ([Edible Brooklyn — Alex Barrotti](https://www.ediblebrooklyn.com/2017/alex-barrotti-pioneer-pos-technology-sponsored/), [Wikipedia](https://en.wikipedia.org/wiki/TouchBistro_Inc.)). De ahí el lema "built for restaurant people, by restaurant people" y la primitiva central: **el iPad viaja a la mesa, no el mozo a la caja**.

### 6.2 Decisiones de UX de mesa que hace bien

1. **Tableside ordering como flujo default**: tomar el pedido en la mesa y que dispare directo a la estación correcta — menos viajes, más tiempo con el cliente, mayor rotación de mesas ([TouchBistro — Tableside](https://www.touchbistro.com/features/tableside-order-management/)).
2. **Hardware familiar**: al ser iPad puro, "los mozos no aprenden un sistema nuevo — usan algo que ya les resulta familiar" ([Bosstab](https://www.bosstab.com/resources/software-guides/pos-systems/touchbistro/)). Consistentemente rankeado entre los POS más fáciles de usar, con "curva de aprendizaje baja" y "menú visual que hace la navegación una brisa" ([tech.co](https://tech.co/pos-system/touchbistro-pos-review)).
3. **El floor plan como panel de información operativa**: cada mesa registra cuánto hace que está sentada, cuánto gastó y cuántas personas son; el manager ve la ocupación en tiempo real y anticipa cuándo libera mesa ([TouchBistro — Floor plan & table management](https://www.touchbistro.com/features/floor-plan-table-management/)).
4. **Color por mozo**: las mesas de la sección asignada a un empleado se pintan con **el color de ese empleado** — responsabilidad visible de un vistazo ([TouchBistro Help — Floorplan](https://help.touchbistro.com/s/article/Managing-Tables-in-Floorplan-in-the-TouchBistro-Reservations-App?language=en_US)).
5. **Defaults que aceleran el armado**: mesa nueva = 2 asientos y número autoincremental; editable después ([TouchBistro Help — Setting up your floor plan](https://www.touchbistro.com/help/articles/chapter-6-setting-floor-plan/)).
6. **Split/merge ágil en la mesa**: separar y combinar checks, mesas y pedidos rápido como parte del flujo de pago ([TouchBistro — Tableside](https://www.touchbistro.com/features/tableside-order-management/)).
7. **Upsell prompts**: pop-ups que recuerdan al mozo ofrecer extras en el momento del pedido ([TouchBistro — Tableside](https://www.touchbistro.com/features/tableside-order-management/)).
8. **Arquitectura híbrida offline-first**: servidor local (Mac mini/iPad hub) + cloud; si se corta internet, el servicio sigue y sincroniza después ([Kitchen Business](https://kitchenbusiness.com/touchbistro-review/)). Para un restaurante, "nunca estar caído" es una decisión de UX, no de infraestructura.

### 6.3 Lo que la gente odia de TouchBistro

- **Contratos y cancelación** (la queja dominante en Trustpilot): cobros meses después de pedir la baja, renovación automática sin aviso, penalidades no explicadas ([BusinessExpert UK](https://www.businessexpert.co.uk/payment-processing/touchbistro-review/)).
- **Soporte lento** y sin teléfono para hardware; usuarios reportando "2 horas por día hablando con soporte" sin resolución ([Capterra — TouchBistro reviews](https://www.capterra.com/p/140677/TouchBistro/reviews/)).
- **Fragilidad de la red local**: lectores que se desconectan, tickets que salen por la impresora equivocada, pérdida de pedidos cuando el hub no está actualizado y las tablets sí ([Capterra](https://www.capterra.com/p/140677/TouchBistro/reviews/)). El reverso de la arquitectura híbrida: el cliente pasa a ser su propio administrador de red.
- Reportes flojos para contabilidad, integraciones limitadas, iOS-only ([Capterra](https://www.capterra.com/p/140677/TouchBistro/reviews/)).

---

## 7. Onboarding comparado: crear una cuenta nueva

### Square (el benchmark)

1. **Sign-up online en ~5 minutos**: email, tipo de negocio, facturación estimada, empleados — la selección de tipo de negocio dirige qué producto/POS y qué guía se muestra ([Square Help — Get Started Guide](https://squareup.com/help/us/en/article/5123-square-get-started-guide), [Page Flows — flujo con screenshots](https://pageflows.com/post/desktop-web/onboarding/square/)).
2. **Checklist de setup en el Dashboard** con tareas ordenadas y opcionales (verificar identidad, banco, ítems, equipo, hardware). Si no tenés hardware, **Square te recomienda el kit según tu modelo de negocio** ([Square Help](https://squareup.com/help/us/en/article/5123-square-get-started-guide)).
3. **Tres caminos para el menú**: manual en el Dashboard / subir archivo del menú existente / **importar desde Clover o Toast** (migración asistida de competidores) ([Square Help](https://squareup.com/help/us/en/article/6407-get-started-with-square-for-restaurants)). Para catálogos grandes, import/export por CSV con tool propia ([Square Online Help](https://square.online/app/help/us/en/topics/import-export-and-batch-update-products-with-a-csv-file)).
4. **Hardware out-of-the-box**: encender → Wi-Fi → device code → vender; <10 min ([POS USA](https://www.posusa.com/square-terminal-review/)).
5. **Sin contrato, sin demo obligatoria, sin vendedor**: el trial es el producto. (Toast y TouchBistro requieren hablar con ventas; Lightspeed requiere onboarding guiado).

### Lightspeed

Onboarding self-service con especialista asignado pero asincrónico y lento (email, 1-2 días de respuesta); checklist oficial de lanzamiento larga (menú, taxes, usuarios, layout de botones, impresoras) **antes** de poder operar ([Lightspeed — Launching checklist](https://k-series-support.lightspeedhq.com/hc/en-us/articles/1260805671909-Launching-Lightspeed-Restaurant-checklist), [Capterra](https://www.capterra.com/p/211849/Lightspeed-Resturant/reviews/)).

### TouchBistro

Venta asistida + setup de red local (hub) → más fricción inicial que Square, compensada con UI familiar iPad una vez instalado; el riesgo queda en el contrato ([BusinessExpert UK](https://www.businessexpert.co.uk/payment-processing/touchbistro-review/)).

---

## 8. Lo que la gente AMA y ODIA (resumen con fuentes)

### Square
- **AMA**: entrenar a un empleado nuevo en minutos; precio de entrada; todo-en-uno (pagos+POS+online+banca); "el primer POS que pude personalizar completamente yo solo" ([Capterra](https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/), [Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)).
- **ODIA**: **retención de fondos / cuentas congeladas sin aviso ni explicación** (la queja más grave y recurrente del ecosistema Square; soporte inaccesible durante el proceso) ([Merchant Maverick](https://www.merchantmaverick.com/reviews/square-for-restaurants-pos-review/)); soporte limitado en plan free (L-V 6-18 PT); bugs operativos (Auto-86, cajón, crashes de iPad); inventario que "no resuelve el problema del restaurante" sin terceros; fees por transacción que escalan con el volumen ([Square Community](https://community.squareup.com/t5/Square-for-Restaurants/Constant-Issues-with-Square-for-Restaurants/td-p/353102), [Capterra](https://www.capterra.com/p/175628/Square-Point-of-Sale/reviews/)).

### Lightspeed
- **AMA**: profundidad — inventario a nivel ingrediente, Advanced Insights (rentabilidad por plato, performance por mozo), floor plan de primera, offline por Lightserver ([TheRealBarman](https://therealbarman.com/lightspeed-pos-review/), [POS USA](https://www.posusa.com/lightspeed-restaurant-pos-review/)).
- **ODIA**: setup tedioso y curva de aprendizaje alta; soporte lento en onboarding; cierre de caja confuso; contrato anual; costos extra (KDS por pantalla) ([Capterra](https://www.capterra.com/p/211849/Lightspeed-Resturant/reviews/), [MobileTransaction](https://www.mobiletransaction.org/lightspeed-restaurant-pos-review/)).

### TouchBistro
- **AMA**: el flujo de mozo en la mesa (pedido → cocina sin viajes), interfaz iPad familiar y visual, split de cuentas rápido, sigue operando sin internet ([tech.co](https://tech.co/pos-system/touchbistro-pos-review), [TouchBistro](https://www.touchbistro.com/features/tableside-order-management/)).
- **ODIA**: prácticas de contrato/cancelación (cobros post-baja), soporte lento, fragilidad de la red local (impresoras/lectores/sync del hub), reportes contables flojos ([Capterra](https://www.capterra.com/p/140677/TouchBistro/reviews/), [BusinessExpert UK](https://www.businessexpert.co.uk/payment-processing/touchbistro-review/)).

---

## 9. Lecciones para PASE+COMANDA

### 9.1 Qué IMITAR

1. **Settings templates por tipo de local** (la idea individual más potente de Square): al dar de alta un local en el onboarding de PASE, preguntar "¿mostrador, salón o barra?" y derivar TODOS los defaults de COMANDA de esa respuesta (modo POS inicial, auto-gratuity off/on, ruteo directo de bebidas, pantalla post-ítem). Una pregunta ≫ treinta toggles. Encaja directo en el wizard `/onboarding` existente.
2. **Separar taxonomía de layout** como Square (categories ≠ menu groups): que reordenar/colorear la grilla del POS de COMANDA nunca toque reportes ni ruteo de impresión. Si hoy COMANDA usa categorías para ambas cosas, es deuda a saldar antes de que algún cliente quiera personalizar su grilla.
3. **Wizard implícito de modifiers**: auto-avanzar por los grupos de modifiers requeridos al tocar un ítem, en orden, sin que el mozo tenga que saber qué falta. Es la diferencia entre "formulario" y "flujo".
4. **Device code para enchufar cajas**: código corto generado en PASE → tipearlo en el dispositivo COMANDA → caja operativa; empleados con PIN. Ya tenemos `comanda_usuarios` con PIN; falta la identidad-de-dispositivo barata.
5. **Defaults derivados + nada bloquea la primera venta**: la filosofía Square de "arrancá con defaults, afiná después". Auditar el onboarding actual de PASE con esa vara: ¿cuántos pasos son realmente bloqueantes para la primera venta?
6. **Coursing estilo hold & fire** (cuando toque): cursos como grupos visibles en el carrito con ícono fuego/pausa por curso + "fire ticket" a cocina. Es el patrón más simple que resuelve el 90% del coursing real.
7. **De TouchBistro**: mesa = panel de info (tiempo sentada + gasto + cubiertos), color de mesa por mozo asignado, y defaults al crear mesas (2 asientos, número autoincremental). Directamente aplicable al editor de plano de COMANDA y a MESA.
8. **De Lightspeed**: covers (cubiertos) como primitiva al abrir mesa — habilita split en partes iguales y ticket promedio por comensal, y es exactamente el dato que MESA va a necesitar para el CRM. Y "Send – x ítems" como acción explícita y contable.
9. **Import del menú del sistema anterior** como camino de onboarding de primera clase (Square importa de Clover/Toast): para PASE el equivalente es importar de Maxirest/Fudo/Excel — ya tenemos el parser Maxirest v3, convertirlo en paso del wizard.
10. **Checklist de setup visible y reanudable** en el dashboard (no un wizard bloqueante): tareas ordenadas con check, cada una salteable.

### 9.2 Qué EVITAR

1. **No paywall-ear lo operativo básico de salón** (el error estratégico de Square): coursing/seats detrás de un plan pago es la razón #1 por la que los full-service eligen Toast. PASE+COMANDA compite justamente en full-service argentino: el salón completo tiene que estar en el core.
2. **No romper la estabilidad espacial del back-office**: las quejas por el rediseño del Dashboard 2024-25 de Square muestran que mover secciones de lugar tiene costo real. Cuando fusionamos pantallas (como Finanzas→Negocio), siempre dejar redirect + alias (ya lo hicimos con `altSlugs` — mantener esa disciplina).
3. **No acumular productos/series incoherentes** (el pecado de Lightspeed K/L/O/U): un solo COMANDA, una sola terminología, una sola doc. Si algún día compramos/forkeamos algo, fusionar de verdad antes de vender.
4. **No depender de configuración previa pesada** (Lightspeed: "hay mucho que configurar antes de usar el POS"). Cada setting nuevo en COMANDA debería nacer con default sensato, jamás con "requerido antes de operar".
5. **No replicar la fragilidad de red local de TouchBistro sin su mitigación**: nuestro offline-first ya existe; la lección es invertir en *higiene de sync* y diagnóstico visible (ya aprendido con la cola offline y los wrappers `_offline`) porque la mitad del odio a TouchBistro es "la impresora imprimió en cualquier lado y nadie sabe por qué".
6. **No esconder el soporte detrás del plan** ni hacer cancelación hostil (TouchBistro): en un mercado chico como Argentina, la reputación de "te cobran después de darte de baja" mata.
7. **No prometer inventario que no descuenta de verdad**: la queja de Square ("no resuelve inventario, necesitás terceros") valida nuestra decisión del circuito A→E con recetas anidadas y descuento real de stock — eso es diferencial, no commodity.

### 9.3 Qué MEJORAR (donde podemos superarlos)

1. **Día 1 de Square + salón de Toast/Lightspeed en un solo producto**: ninguno de los tres lo tiene. Square es fácil pero chato para mesas; Lightspeed es profundo pero pesado de arrancar. El template "salón" de COMANDA puede dejar un full-service operativo en una hora — eso hoy no existe ni en USA.
2. **Inventario nivel ingrediente SIN curva Lightspeed**: nuestra bandeja de conciliación (mapear renglones de factura → insumo una sola vez, con memoria y auto-match) es un onboarding de inventario más suave que el de Lightspeed, que exige cargar todo antes. Profundizar ese ángulo: el inventario se construye solo a medida que comprás.
3. **POS + reservas + back-office nativos** (MESA): Lightspeed recién en 2026 está agregando reservas nativas; TouchBistro las vende como producto aparte; Square las tiene desacopladas (Square Appointments no es para restaurantes). La disponibilidad en tiempo real leyendo mesas abiertas de COMANDA sigue siendo un diferencial sin equivalente directo.
4. **Confianza en los fondos**: el terror #1 con Square es la plata retenida. PASE no procesa pagos (MP/banco son del cliente) — comunicarlo como ventaja: "tu plata nunca pasa por nosotros".
5. **Cierre de caja claro**: usuarios de Lightspeed dicen que su cierre "no tiene sentido". Nuestro modelo ledger-first (saldos como cache derivado de movimientos, C4-F16) permite un cierre explicable línea por línea — convertirlo en feature visible, no solo arquitectura.

---

*Informe generado el 11-jun-2026. Fuentes principales: squareup.com/help, k-series-support.lightspeedhq.com, touchbistro.com, merchantmaverick.com, fitsmallbusiness.com, capterra.com, g2.com, certus-ai.com, owner.com, aplosai.com, therestauranthq.com, mobiletransaction.org, investing.com, beehexa.com, betakit.com, figma.com/customers/square, pageflows.com, posusa.com, tech.co, businessexpert.co.uk, kitchenbusiness.com, ediblebrooklyn.com.*
