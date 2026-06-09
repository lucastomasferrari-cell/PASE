# Análisis de competencia — PASE + COMANDA + MESA (junio 2026)

> Fecha: 2026-06-09 · Investigación web + lectura del producto real (CONTEXTO.md, specs, pantallas COMANDA).
> Moneda: ARS = pesos argentinos, USD = dólares. Los precios en ARS pierden vigencia rápido por inflación — tomarlos como orden de magnitud, no como número exacto.

---

## 1. Resumen ejecutivo

### Dónde estamos FUERTES

- **Profundidad de back-office que nadie tiene en Argentina.** PASE hoy hace cosas que en el mercado local directamente no existen en un solo producto: conciliación automática de MercadoPago, lector de facturas con IA, RRHH con liquidación según LCT argentina (SAC, vacaciones por antigüedad, liquidación final, quincenas, adelantos), costeo de recetas en cascada con sub-recetas, stock con conteo ciego, CMV/AvT, EERR devengado. Para tener eso hoy un restaurante argentino tendría que pagar Fudo/Maxirest + MarketMan (USD 199+/mes) + un contador + planillas — y aún así no le cierra el círculo.
- **El stack integrado POS + back-office + reservas** es un diferencial que ni Toast tiene completo (Toast no es dueño de un CRM de reservas nivel SevenRooms; SevenRooms no es dueño del POS). La disponibilidad de mesas EN VIVO leyendo tickets abiertos del POS (MESA) no la ofrece nadie.
- **IA aplicada de verdad**: lector de facturas, bot Instagram/WhatsApp. Fudo cobra $55.000 ARS/mes solo por su "Recepcionista IA" ([fu.do/precios](https://fu.do/es-ar/precios/)).

### Dónde estamos FLOJOS

- **No facturamos electrónico (AFIP/ARCA).** Es EL bloqueante para vender en Argentina. Desde el 1-ago-2026 el CAE es obligatorio para todos los inscriptos en IVA ([RG 5782/2025 + prórroga RG 5852/2026](https://www.infozona.com.ar/cae-arca-afip-2026-que-es-como-obtener-cambio-junio-caea/)). Fudo lo cobra como módulo ($13.500/mes), Maxirest lo incluye gratis en todos los planes. Sin esto, COMANDA no puede reemplazar al sistema que el local ya tiene.
- **No cobramos integrado**: Maxirest integra Mercado Pago QR, Clover y Payway; Fudo tiene terminal de pago in-house. Nosotros conciliamos MP pero el cobro en el POS es manual.
- **No inyectamos pedidos de Rappi/PedidosYa**: hay pantallas y webhook handler genérico spec'd, pero no hay integración certificada con los partners. Maxirest y Fudo la tienen productiva.
- **MESA todavía no existe como producto** (spec aprobado, módulo 1 sin construir) mientras Meitre ya es el estándar del fine-dining argentino y CoverManager avanza en LATAM.

### Las 5 features gap más valiosas para construir

| # | Gap | Por qué | Esfuerzo |
|---|-----|---------|----------|
| 1 | **Facturación electrónica ARCA (CAE) desde COMANDA** | Obligatoria desde ago-2026; sin esto no hay venta posible en AR. Fudo la cobra $13.500/mes → además es revenue | Grande |
| 2 | **Integración Rappi/PedidosYa (inyección de pedidos al POS)** | Todo local con delivery la exige como básico; Fudo cobra $19.500/mes por esto | Medio |
| 3 | **Cobro integrado MP QR / Point desde el POS** | Cierra el loop venta→cobro→conciliación (que ya tenemos); estándar en Maxirest | Medio |
| 4 | **Página pública de reservas + notificaciones WhatsApp (MESA mód. 4+6)** | Es lo que convierte MESA en producto vendible; OpenTable casi no opera en AR (27 restaurantes) → ventana abierta | Medio |
| 5 | **Scheduling de turnos del personal (horarios semanales + control de asistencia)** | Toast/R365 lo tienen, nadie local lo tiene bien; encaja natural con nuestro RRHH LCT | Medio |

---

## 2. Tablas comparativas por producto

### 2.1 PASE vs back-office competidores

Leyenda: ✅ lo tiene bien · 🟡 parcial/débil · ❌ no lo tiene

| Feature | **PASE** | R365 (US) | MarketMan | Apicbase | Fudo Pro | Maxirest Pro | Bistrosoft |
|---|---|---|---|---|---|---|---|
| Caja/tesorería multi-cuenta multi-local | ✅ | ✅ | ❌ | ❌ | 🟡 (cajas y turnos) | ✅ | 🟡 |
| Compras / cuentas corrientes proveedores | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 |
| Órdenes de compra + 3-way match | 🟡 (spec #4, no impl.) | ✅ | ✅ | ✅ | ❌ | 🟡 | ❌ |
| Lector de facturas con IA | ✅ (Opus, human-in-the-loop) | 🟡 (OCR) | 🟡 (falla seguido según reviews) | 🟡 | ❌ | ❌ | ❌ |
| Recetario con sub-recetas anidadas + costeo cascada | ✅ | ✅ | ✅ | ✅ | 🟡 (recetas simples) | 🟡 | 🟡 |
| Stock con conteo ciego + mermas | ✅ | ✅ | ✅ | ✅ | 🟡 (con bugs reportados) | 🟡 | 🟡 |
| CMV / AvT (actual vs teórico) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Menu engineering matrix | ✅ (reporte en COMANDA) | ✅ | 🟡 | ✅ | ❌ | ❌ | ❌ |
| EERR / P&L | ✅ (devengado + percibida) | ✅ (contabilidad completa) | ❌ | ❌ | 🟡 (estado de resultados) | 🟡 | ❌ |
| Conciliación MercadoPago automática | ✅ | ❌ (bancos US) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Conciliación bancaria | 🟡 (spec #5) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| RRHH liquidación LCT argentina (SAC, vacaciones, liq. final) | ✅ | ❌ (payroll US) | ❌ | ❌ | ❌ | 🟡 (gestión personal básica) | ❌ |
| Scheduling de turnos del personal | ❌ | ✅ | ❌ | ✅ (planning) | ❌ | ❌ | ❌ |
| Forecasting IA (demanda/staffing) | ❌ | ✅ | 🟡 | ✅ | ❌ | ❌ | ❌ |
| Multi-tenant SaaS vendible | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bot Instagram/WhatsApp con IA | ✅ | ❌ | ❌ | ❌ | 🟡 ($55.000/mes extra) | ❌ | ❌ |
| Facturación electrónica ARCA | ❌ | n/a | n/a | n/a | ✅ ($13.500/mes) | ✅ (incluida) | ✅ |
| Export contable / IVA contador | ✅ (Contador IVA) | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ (es su fuerte vía Contabilium) |

### 2.2 COMANDA vs POS competidores

| Feature | **COMANDA** | Toast | Square Rest. | Lightspeed | Fudo | Maxirest |
|---|---|---|---|---|---|---|
| Mesas / plano de salón editable | ✅ (SalonLayoutEditor) | ✅ | ✅ | ✅ (su fuerte) | ✅ (módulo $8.500/mes) | ✅ |
| Comandas → cocina + KDS | ✅ | ✅ (referente) | ✅ | 🟡 ($30/pantalla) | ✅ (módulo $19.500/mes) | ✅ (Kitchen app) |
| Coursing / tiempos por plato | 🟡 (spec #6) | ✅ | 🟡 | 🟡 | ❌ | 🟡 |
| Split de cuenta por comensal (order-by-seat) | ✅ | ✅ | ✅ | ✅ | 🟡 (módulo $13.500/mes) | 🟡 |
| Offline-first real | ✅ | ✅ | 🟡 | ❌ (débil, cloud-dependiente) | 🟡 | 🟡 (local Windows) |
| Turnos de caja / arqueo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Menú QR + pedido del cliente | ✅ | ✅ | ✅ | ✅ | ✅ (carta QR) | ✅ (Waitry integ.) |
| Tienda online propia | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 (Ordering) |
| Cobro integrado (QR/tarjeta desde el POS) | ❌ | ✅ (es su negocio: 2,49%+15¢) | ✅ (2,6%) | ✅ | ✅ (terminal propia) | ✅ (MP QR, Clover, Payway) |
| Facturación fiscal del ticket | ❌ | n/a (US) | n/a | n/a | ✅ | ✅ |
| Integración Rappi/PedidosYa | 🟡 (pantallas, sin certificar) | n/a | n/a | 🟡 | ✅ (módulo) | ✅ |
| Delivery propio con riders/dispatch | ✅ (DispatchMap, Rider) | ✅ (Toast Delivery) | 🟡 | ❌ | 🟡 | 🟡 |
| Fidelidad / cupones / reseñas | ✅ | ✅ (add-on pago) | ✅ (add-on) | ✅ | ❌ | 🟡 (Alax) |
| Reportes (ventas, productos, tiempos, canales, CMV, performance empleados) | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Handheld / mozo con celular | ✅ (HandheldView) | ✅ | ✅ | ✅ | ✅ (app camareros) | ✅ (Adición mobile) |
| Kiosko autoservicio | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Gift cards | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Permisos granulares por rol + manager override TOTP | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |

### 2.3 MESA vs sistemas de reservas

| Feature | **MESA (spec)** | OpenTable | Resy | SevenRooms | CoverManager | Meitre |
|---|---|---|---|---|---|---|
| Agenda de reservas + estados | 🟡 (mód. 1, por construir) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Floor plan visual | 🟡 (mód. 2) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Disponibilidad EN VIVO leyendo el POS** | ✅ (diseñado, único) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Waitlist walk-ins | 🟡 (mód. 3) | ✅ | ✅ (referente) | ✅ | ✅ | 🟡 |
| Página pública / widget de reserva | 🟡 (mód. 4) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Marketplace de descubrimiento (red de comensales) | ❌ (no planeado) | ✅ (su foso) | ✅ | ❌ | 🟡 | ❌ |
| CRM 360° auto-llenado con consumo real del POS | ✅ (mód. 5, diseñado — nativo) | 🟡 | 🟡 | ✅ (100+ datos, pero vía integraciones pagas) | 🟡 | ✅ (CRM propio) |
| Anti no-show (depósitos, prepago, tarjeta de garantía) | 🟡 (a diseñar) | ✅ (+2% fee sobre prepagos) | ✅ | ✅ | ✅ | ✅ (depósitos prepagos) |
| Notificaciones WhatsApp/SMS/email | 🟡 (mód. 6) | ✅ | ✅ | ✅ | ✅ (fuerte WhatsApp) | ✅ |
| Revenue management / pricing dinámico | 🟡 (mód. 7) | 🟡 | 🟡 | ✅ | 🟡 | ✅ (asignación por demanda) |
| Sin comisión por cubierto | ✅ (decisión de diseño) | ❌ ($1–1,50/cover red) | ✅ | ✅ | ✅ (directas) | ✅ |
| Opera/cobra en Argentina | ✅ (nativo) | 🟡 (solo ~27 restaurantes) | ❌ | 🟡 (enterprise) | 🟡 (España fuerte, LATAM creciendo) | ✅ (argentino) |

---

## 3. Features que ELLOS tienen y NOSOTROS NO (priorizadas para el mercado argentino)

Ordenadas por valor de venta en Argentina. Esfuerzo: 🔵 chico · 🟠 medio · 🔴 grande.

1. **🔴 Facturación electrónica ARCA (CAE) integrada al cobro.** Obligatoria para todos desde el 1-ago-2026 ([prórroga RG 5852/2026](https://www.infozona.com.ar/cae-arca-afip-2026-que-es-como-obtener-cambio-junio-caea/), [guía Zetek](https://www.zetek.com.ar/blog/news/facturacion-electronica-arca-2026-guia-completa-para-negocios-en-argentina)). Todos los locales la necesitan; todos los competidores AR la tienen. Existe el atajo [AFIP SDK](https://afipsdk.com/industries/gastronomy/) para acelerar. **Sin esto no se puede vender COMANDA como POS principal. Punto.**
2. **🟠 Inyección de pedidos Rappi/PedidosYa al POS.** Fudo lo vende a $19.500/mes; Maxirest lo incluye desde el plan base. Tenemos las pantallas (`ConectarPartners`, `LogWebhooksExternos`) y el modelo unificado de pedidos spec'd (Spec #8) — falta la certificación/integración real con los partners.
3. **🟠 Cobro integrado Mercado Pago QR / Point + Clover/Payway.** Hoy el mozo cobra "afuera" del sistema. Integrarlo cierra el círculo con la conciliación MP que ya es nuestra fortaleza. Maxirest ya lo tiene ([planes Maxirest](https://maxirest.com.ar/planes)).
4. **🟠 Página pública de reservas white-label + recordatorios WhatsApp** (MESA módulos 4 y 6). Es lo mínimo para competir con Meitre/CoverManager. CoverManager cobra €99–250/mes por esto ([análisis precios](https://mesabot.es/covermanager-precios)); Meitre no publica precios.
5. **🟠 Scheduling de turnos del personal** (grilla semanal, disponibilidad, intercambios, costo laboral proyectado). Toast y R365 lo tienen; en AR nadie lo hace bien y pega perfecto con nuestro RRHH. Es además la puerta al control de asistencia (fichaje) que el spec #1 ya contempla.
6. **🟠 Depósitos / seña anti no-show en reservas** (cobrar una seña por MP al reservar). Meitre lo usa como arma principal en fine-dining; OpenTable cobra 2% por estos cobros. Encaja con MESA mód. 1-4.
7. **🔵 Gift cards / tarjetas regalo.** Toast/Square/Lightspeed lo tienen como add-on rentable. Modelo simple (saldo prepago = pasivo), buen upsell.
8. **🟠 Forecasting de demanda con IA** (ventas proyectadas por día/franja → compras sugeridas y staffing). Square lo marketinea fuerte, Apicbase también. Tenemos los datos (ventas por hora + recetas + stock); es un buen "wow" de demo.
9. **🔵 App móvil del dueño** (resumen del día, alertas, aprobar overrides). Maxirest tiene "Manager App". Nuestra web es responsive; empaquetar una PWA instalable con push (ya tenemos push) es esfuerzo chico.
10. **🔴 Kiosko autoservicio.** Toast/Square lo tienen. En AR todavía es nicho (fast-food grande) — baja prioridad, no construir ahora.
11. **🔵 Encuesta post-visita automática** (link al cerrar ticket → reseña interna o Google). Ya tenemos reseñas multi-aspecto; falta el disparo automático post-cobro.

**Nota sobre lo que NO vale la pena perseguir:** el marketplace de descubrimiento de OpenTable (red de millones de comensales) no es replicable y en AR casi no existe (~27 restaurantes listados — [opentable.com/metro/argentina](https://www.opentable.com/metro/argentina)). La jugada correcta es la de Resy/CoverManager: sin comisión por cubierto, white-label, el restaurante es dueño de su demanda.

---

## 4. Features que NOSOTROS tenemos y ellos NO (diferenciales para el pitch)

1. **Un solo stack: reserva → comanda → cobro → contabilidad → CMV.** Nadie lo tiene: Toast no tiene CRM de reservas nivel SevenRooms, SevenRooms no es dueño del POS ([sus integraciones son pagas y frágiles](https://hoteltechreport.com/food-and-beverage/restaurant-crm/sevenrooms)), Fudo/Maxirest no tienen back-office financiero profundo. Pitch: *"sabés todo de tu negocio y de tu cliente sin integrar nada"*.
2. **Disponibilidad de mesas en TIEMPO REAL** (MESA lee tickets abiertos de COMANDA). OpenTable/Resy muestran inventario estático. Es el feature estrella diseñado y es literalmente imposible de copiar sin ser dueño del POS.
3. **Conciliación automática de MercadoPago** (sync cada 30 min, release reports autoritativos, saldo real vs liquidaciones). Ningún competidor AR la tiene integrada. En un país donde MP domina los cobros, esto solo justifica el abono.
4. **RRHH según LCT argentina**: SAC, vacaciones por antigüedad, presentismo, quincenas, adelantos con descuento por fecha, liquidación final (Art. 245/232), recibos. R365 hace payroll pero de USA; Fudo/Maxirest/Bistrosoft no liquidan sueldos. Hoy esto se hace en Excel + contador.
5. **Lector de facturas IA human-in-the-loop afinado para facturas argentinas** (92% confianza en facturas reales con tinta gris). El invoice scanning de MarketMan "no funciona la mitad de las veces" según sus propios usuarios ([reviews](https://checkthat.ai/brands/marketman/reviews)).
6. **CMV/AvT + menu engineering + costeo en cascada dentro del mismo sistema.** Para tener esto un local argentino hoy necesita MarketMan (USD 199/mes + USD 500 setup) o Apicbase (USD 160+/mes) **además** del POS, en inglés, sin AFIP ni proveedores locales.
7. **Bot Instagram/WhatsApp con IA que responde y toma reservas.** Fudo cobra $55.000 ARS/mes por su "Recepcionista IA". Nosotros lo tenemos nativo con Claude, multi-tenant.
8. **Offline-first real en el POS** con cola de sync — Lightspeed es débil ahí y los cortes de internet en AR son un argumento de venta concreto.
9. **Permisos finos + manager override TOTP + auditoría completa** — nivel enterprise que los locales AR no ofrecen.
10. **Sin comisión por cubierto en reservas** (vs OpenTable $1–1,50 por comensal de red + 2% sobre prepagos — [eatapp pricing review](https://restaurant.eatapp.co/blog/opentable-pricing)).

---

## 5. Pricing del mercado (referencia para el nuestro)

### POS / gestión — Argentina (ARS/mes, sin IVA salvo indicación)

| Producto | Entrada | Medio | Full | Fuente |
|---|---|---|---|---|
| **Fudo** | $20.900 (Inicial) | $41.000 (Avanzado) | $65.000 (Pro) + módulos: Fact. electrónica $13.500, Mesas $8.500, KDS $19.500, Delivery apps $19.500, Comensal $13.500, IA $55.000 → **Pro "completo" ≈ $125–145k** | [fu.do/es-ar/precios](https://fu.do/es-ar/precios/) |
| **Maxirest** | $44.520 (Point, promo; reg. $59.360) | $64.395 (Xpress; reg. $85.860) | desde $130.899 (Pro, back-office completo). Combos con hardware $199.900–265.000 | [maxirest.com.ar/planes](https://maxirest.com.ar/planes) |
| **Bistrosoft** | desde $35.500 + IVA | — | — (sin permanencia mínima) | [bistrosoft.com/ar/precios](https://bistrosoft.com/ar/precios/) |

Todos descuentan 10–15% por pago semestral/anual (cobertura inflación).

### POS — internacionales (USD/mes, por local; NO operan en Argentina)

| Producto | Planes | Extras | Fuente |
|---|---|---|---|
| **Toast** | $0 / $69 / $110+ | Processing 2,49% + 15¢; hardware USD 799–1.500; contrato 2 años; costo real típico USD 250–1.200/mes con add-ons | [pos.toasttab.com/pricing](https://pos.toasttab.com/pricing), [análisis costos](https://www.upmenu.com/blog/toast-pricing/) |
| **Square for Restaurants** | $0 / $49 / $149 | Processing 2,6% + 10¢ presencial | [squareup.com pricing](https://squareup.com/us/en/point-of-sale/restaurants/pricing) |
| **Lightspeed Restaurant** | $69 / $189 / $399 | KDS $30/pantalla; processing 2,6% + 10¢ | [posusa review](https://www.posusa.com/lightspeed-restaurant-pos-review/) |

### Back-office / inventario especializado (USD/mes)

| Producto | Precio | Nota | Fuente |
|---|---|---|---|
| **MarketMan** | desde $199 + $500 setup | Solo inventario/compras; quejas fuertes de setup (6–12 semanas) y cancelación | [marketman.com/pricing](https://www.marketman.com/pricing-for-restaurant-inventory-management-system), [reviews](https://checkthat.ai/brands/marketman/reviews) |
| **Restaurant365** | $249–635 por local | Contabilidad+inventario+workforce US-only; curva de aprendizaje alta | [restaurant365.com/pricing](https://www.restaurant365.com/pricing/) |
| **Apicbase** | desde ~$160 por outlet | Multi-site F&B europeo; requiere equipo dedicado | [softwaresuggest](https://www.softwaresuggest.com/apicbase-food-management) |

### Reservas (USD o EUR/mes)

| Producto | Precio | Comisión | Fuente |
|---|---|---|---|
| **OpenTable** | $149 / $299 / $499 | $1–1,50 por cubierto de red + 2% sobre prepagos (2026) | [eatapp análisis](https://restaurant.eatapp.co/blog/opentable-pricing), [tablelink](https://tablelink.app/blog/opentable-fees-explained) |
| **Resy** | $249–899 | sin per-cover (oficial; hay reportes de $0,25–0,50) | [resy.com/plans](https://resy.com/resyos/plans-and-pricing/), [tablelink](https://tablelink.app/blog/resy-fees-explained) |
| **SevenRooms** | ~$499+ (cotización) | sin comisión; pricing opaco | [hoteltechreport](https://hoteltechreport.com/food-and-beverage/restaurant-crm/sevenrooms) |
| **CoverManager** | €99–400 según módulos | sin comisión directas; algunos planes con per-cover | [chefbusiness](https://chefbusiness.co/covermanager-opiniones-resena-software-reservas-restaurantes/), [mesabot](https://mesabot.es/covermanager-precios) |
| **Meitre** (AR) | no público (cotización) | sin comisión; depósitos prepagos | [meitre.com](https://meitre.com/es), [tracxn](https://tracxn.com/d/companies/meitre/__3s-cMjFnShKVp0fR6WfQLmYGb5PlKzqKwaBkhfrCU5o) |

### Implicancia para nuestro pricing

- El techo del mercado AR para POS+gestión full está en **$130–150k ARS/mes por local** (Maxirest Pro, Fudo Pro con módulos). El piso "serio" es ~$40–65k.
- Nuestra propuesta hace lo de Fudo Pro + módulos **más** lo de MarketMan (USD 199 ≈ $250k+ ARS al cambio) **más** RRHH **más** conciliación MP. Hay espacio para un bundle PASE+COMANDA en la franja **$80–180k ARS/mes por local** según módulos, y seguir siendo más barato que la suma de las partes.
- Estrategia de los locales que funciona acá: precio base accesible + módulos (como Fudo), descuento por pago anual (cobertura inflación), sin contrato de permanencia (diferencial vs Toast/Lightspeed, que generan odio con sus contratos — [reviews Lightspeed](https://www.posusa.com/lightspeed-restaurant-pos-review/)).
- MESA: cobrar plano mensual sin comisión por cubierto (modelo Resy/CoverManager). Referencia: $50–100 USD-equivalente/mes. Contra OpenTable es fácil argumentar: un restaurante con 1.000 cubiertos de red/mes le paga a OpenTable USD 1.500+/mes.

---

## 6. Amenazas y oportunidades del mercado argentino

### Oportunidades

1. **CAE obligatorio 1-ago-2026** ([RG 5782/2025, prórroga RG 5852/2026](https://www.infozona.com.ar/cae-arca-afip-2026-que-es-como-obtener-cambio-junio-caea/)): todos los gastronómicos están siendo empujados a facturar electrónico con multas y clausuras de por medio ([El Cronista](https://www.cronista.com/economia-politica/facturas-electronicas-arca-da-una-prorroga-y-estas-son-las-multas-y-clausuras-si-no-te-adaptas-a-tiempo/)). Momento perfecto para entrar con facturación integrada — los locales van a estar revisando su software este año.
2. **Los gigantes no vienen**: Toast opera solo en US/CA/UK/IE ([fuente](https://central.toasttab.com/s/article/Differences-in-Toast-s-Back-end-for-Canada-Ireland-and-U-K-Locations)), Square no está en AR, R365/MarketMan son inglés-céntricos sin AFIP. La competencia real es local (Fudo, Maxirest, Bistrosoft) y ninguno tiene back-office financiero profundo.
3. **Reservas mid-market vacío**: OpenTable casi no existe en AR (~27 restaurantes), Meitre apunta al fine-dining top (Don Julio, Tegui, Central), CoverManager recién entra desde España. El bistró/parrilla/café mediano no tiene una opción buena y barata → espacio MESA.
4. **MP domina los cobros** y liquida con delay (tarjetas 8–10 días hábiles para PyMEs — [BCRA](https://www.bcra.gob.ar/noticias/sobre-reduccion-plazos-liquidacion-tarjetas-credito.asp)): la conciliación y la vista percibida/devengada que ya tenemos resuelven un dolor diario real.
5. **Quejas conocidas de los locales**: Fudo con bugs de stock y soporte solo por WhatsApp ([comparasoftware](https://www.comparasoftware.com/fudo)); Maxirest con opiniones polarizadas por soporte y estabilidad ([comparasoftware](https://www.comparasoftware.com.ar/maxirest)). Soporte de calidad es un diferencial barato de construir al principio.

### Amenazas

1. **Fudo tiene 30.000 negocios en LATAM** ([fu.do](https://fu.do/es-ar/)) y precios de entrada agresivos ($20.900/mes): la inercia del instalado es enorme. No competir por precio en el low-end; competir por profundidad en locales que ya facturan en serio.
2. **Mercado Pago empuja su propio POS gratis** (Point + app): come el segmento más chico (kioscos, cafés mínimos). Refuerza la decisión de apuntar al restaurante con mesas y operación real.
3. **Inflación + pricing en ARS**: hay que ajustar precios cada pocos meses como hacen todos (Fudo publica PDF de precios mensual; Maxirest da "25% off por 3 meses"). Diseñar el pricing como variable desde el día uno (tabla de precios versionada, no hardcodeada).
4. **La facturación electrónica trae carga regulatoria continua** (cambios ARCA, CAE/CAEA, percepciones IIBB por jurisdicción): una vez que la ofrecemos, hay que mantenerla al día — es costo permanente de ingeniería, no un feature one-shot.
5. **SevenRooms/DoorDash y CoverManager con plata**: si LATAM se vuelve prioridad para ellos, traen marketing y partnerships. Nuestra defensa es el foso técnico (POS+reservas nativo) que ellos no pueden replicar comprando integraciones.

---

## Fuentes principales

- Toast: [pos.toasttab.com/pricing](https://pos.toasttab.com/pricing) · [upmenu.com/blog/toast-pricing](https://www.upmenu.com/blog/toast-pricing/) · [nerdwallet review](https://www.nerdwallet.com/business/software/reviews/toast-pos)
- Square: [squareup.com restaurants pricing](https://squareup.com/us/en/point-of-sale/restaurants/pricing) · [nerdwallet](https://www.nerdwallet.com/business/software/reviews/square-for-restaurants)
- Lightspeed: [posusa review](https://www.posusa.com/lightspeed-restaurant-pos-review/) · [g2 reviews](https://www.g2.com/products/lightspeed-restaurant/reviews)
- Fudo: [fu.do/es-ar/precios](https://fu.do/es-ar/precios/) · [comparasoftware opiniones](https://www.comparasoftware.com/fudo)
- Maxirest: [maxirest.com.ar/planes](https://maxirest.com.ar/planes) · [comparasoftware](https://www.comparasoftware.com.ar/maxirest)
- Bistrosoft: [bistrosoft.com/ar/precios](https://bistrosoft.com/ar/precios/)
- MarketMan: [marketman.com/pricing](https://www.marketman.com/pricing-for-restaurant-inventory-management-system) · [checkthat.ai reviews](https://checkthat.ai/brands/marketman/reviews)
- Restaurant365: [restaurant365.com/pricing](https://www.restaurant365.com/pricing/) · [g2](https://www.g2.com/products/restaurant365/reviews)
- Apicbase: [get.apicbase.com](https://get.apicbase.com/) · [softwaresuggest](https://www.softwaresuggest.com/apicbase-food-management)
- OpenTable: [eatapp.co/blog/opentable-pricing](https://restaurant.eatapp.co/blog/opentable-pricing) · [tablelink fees](https://tablelink.app/blog/opentable-fees-explained) · [opentable.com/metro/argentina](https://www.opentable.com/metro/argentina)
- Resy: [resy.com/resyos/plans-and-pricing](https://resy.com/resyos/plans-and-pricing/) · [tablelink](https://tablelink.app/blog/resy-fees-explained)
- SevenRooms: [hoteltechreport](https://hoteltechreport.com/food-and-beverage/restaurant-crm/sevenrooms) · [g2](https://www.g2.com/products/sevenrooms/reviews)
- CoverManager: [chefbusiness reseña](https://chefbusiness.co/covermanager-opiniones-resena-software-reservas-restaurantes/) · [mesabot precios](https://mesabot.es/covermanager-precios)
- Meitre: [meitre.com](https://meitre.com/es) · [tracxn profile](https://tracxn.com/d/companies/meitre/__3s-cMjFnShKVp0fR6WfQLmYGb5PlKzqKwaBkhfrCU5o)
- Regulación AR: [infozona CAE 2026](https://www.infozona.com.ar/cae-arca-afip-2026-que-es-como-obtener-cambio-junio-caea/) · [zetek guía ARCA](https://www.zetek.com.ar/blog/news/facturacion-electronica-arca-2026-guia-completa-para-negocios-en-argentina) · [El Cronista multas](https://www.cronista.com/economia-politica/facturas-electronicas-arca-da-una-prorroga-y-estas-son-las-multas-y-clausuras-si-no-te-adaptas-a-tiempo/) · [BCRA plazos tarjetas](https://www.bcra.gob.ar/noticias/sobre-reduccion-plazos-liquidacion-tarjetas-credito.asp)
