# 12 — Lógica de funcionamiento de los sistemas de reservas líderes

> Investigación: junio 2026. Objetivo: entender las LÓGICAS INTERNAS de OpenTable, Resy y SevenRooms (refuerzo: Tock, CoverManager, Meitre) antes de construir MESA.
> No es lista de features ni precios — es cómo *piensan* estos sistemas por dentro.

---

## 1. Modelo de disponibilidad (la lógica core)

Los tres líderes convergen en el **mismo modelo conceptual de 4 capas**. Esto es lo más importante del informe: la disponibilidad NO es "mesas libres a tal hora", es el resultado de aplicar 4 filtros en cadena.

### Capa 1 — Shifts (turnos de servicio)

Todo se configura por **shift** (Almuerzo, Cena, Brunch...), no por día entero. El shift define:
- Ventana horaria (first seating / last seating).
- Qué mesas participan (un sector puede estar fuera del shift de almuerzo).
- Party size mínimo y máximo bookeable online (OpenTable permite 1–50, configurable por shift y por día especial — [Availability Planning](https://support.opentable.com/s/article/Online-Availability-Settings?language=en_US)).
- Las reglas de pacing y turn times de las capas siguientes.

### Capa 2 — Turn times (duración estimada por tamaño de party)

El **turn time es la variable central de todo el sistema**: cuánto tiempo se espera que una party ocupe la mesa. Con él se calcula disponibilidad, se cotizan esperas y se pacea el shift ([OpenTable — turn times](https://support.opentable.com/s/article/turn-times?language=en_US)).

- Se configura **por tamaño de party** (y por shift): una pareja en almuerzo ≈ 45–90 min; un 6-top en cena ≈ 120 min. OpenTable acepta de 15 min a 4 horas por rango de party size.
- Benchmark que usa SevenRooms en su material: parejas ≈ 1,5 h; mesas de 4 ≈ 2 h ([SevenRooms — walk-in/waitlist guide](https://sevenrooms.com/blog/restaurant-walk-in-waitlist-guide/)).
- El estándar de la industria para límites comunicados al comensal: 90 min a 2 h para parties de 2–5; los comensales lo aceptan si se les avisa al reservar ([Tasting Table](https://www.tastingtable.com/1645809/restaurant-reservation-time-limit/)).
- Resy vende como diferencial que trackea **turn times reales** (medidos del servicio) y los usa para ajustar la planificación y la precisión de los quotes de espera ([Resy — reservations](https://resy.com/join/reservations/)).

**Insight clave**: el turn time configurado es una *estimación a ciegas* en todos estos sistemas (salvo cuando hay integración POS). El restaurante lo setea a mano y reza. Acá MESA tiene ventaja estructural: puede medir el turn time real por party size desde los tickets de COMANDA y autoajustarlo.

### Capa 3 — Pacing (flujo de cocina): cubiertos por intervalo de 15 min

El pacing protege a la **cocina**, no al salón. Aunque haya mesas libres, no podés sentar 60 personas en el mismo cuarto de hora.

- **OpenTable "flow controls"**: por cada slot de 15 min del shift se define el máximo de *covers* (cubiertos) y/o de *parties* que pueden reservar. Default: **30 covers cada 15 min**. Cuando se alcanza el límite, ese horario **deja de ofrecerse online aunque haya mesas vacías**. Se puede poner un guion [-] en un slot para bloquearlo del todo ([flow controls](https://support.opentable.com/s/article/flow-controls?language=en_US)).
- **Party pacing**: límite adicional por cantidad de parties (total o por tamaño específico — ej. máx. 1 mesa de 8 por slot).
- **SevenRooms**: el pacing del **shift es la fuente de verdad** — si el shift dice 12 covers por intervalo, ninguna regla puede superarlo. Las *Access Rules* (capa 4) solo pueden **bajar** ese número, nunca subirlo ([Peoplevine — Access Rules in SevenRooms](https://help.peoplevinehelp.com/en/articles/4564380-access-rules-in-seven-rooms)).
- **Resy**: pacea **solo por covers** (no por cantidad de mesas), y es una queja documentada de operadores que quisieran pacear por mesas ([SoftwareAdvice — Resy OS reviews](https://www.softwareadvice.com/retail/resyos-profile/)). Pacing y "Table Access" se editan por shift y determinan qué aparece online vs. qué es bookeable in-house ([Resy helpdesk — availability and pacing](https://helpdesk.resy.com/how-to-edit-table-availability-and-pacing-in-a-shift-S1T3bPXLd)).

### Capa 4 — Inventario físico: mesas + combinaciones

El slot se ofrece solo si existe una mesa (o combinación) que:
1. Esté libre durante **todo el turn time** (no solo al inicio).
2. Tenga min/max de asientos compatible con la party (el "min seats" evita sentar 2 personas en mesa de 6).
3. Las **table combinations** se definen en el floor plan (qué mesas se pueden unir) y participan del cálculo de disponibilidad para parties grandes ([OpenTable — availability setup](https://support.opentable.com/s/article/Advanced-availability-setup-in-GuestCenter?language=en_US)).

**El cálculo final de un slot**: `slot ofrecido = dentro del shift ∧ pacing no agotado ∧ ∃ mesa/combo que cubra el turn time completo`. Si cualquiera de las 4 capas dice no, el horario no aparece. Esto explica el clásico "el sistema no me deja reservar pero veo mesas vacías" — casi siempre es pacing o turn time, no falta de mesas.

### Capa extra de SevenRooms: Access Rules (inventario segmentado)

SevenRooms agrega una capa de **reglas de acceso** sobre el shift: la misma franja horaria se puede partir en "inventarios" distintos (barra walk-in only, mesas del salón para el widget propio, 20% para terceros, slots con prepago para el tasting menu). Cada regla tiene su descripción pública, su política de pago y su canal. Best practice documentada: restringir los canales de terceros a horas valle (17:00 y post-21:00) y reservar las horas pico para el canal directo ([Peoplevine](https://help.peoplevinehelp.com/en/articles/4564380-access-rules-in-seven-rooms)). Es el mecanismo que les permite hacer revenue management de canales.

### Variante Resy: fixed seatings

Resy soporta shifts con **seatings fijos** (ej. dos turnos: 20:00 y 22:30, estilo tasting menu) en vez de slots continuos cada 15 min ([Resy helpdesk — fixed seating times](https://helpdesk.resy.com/how-to-setup-fixed-seating-times-for-your-shifts-H1v2ZPm8O)). Tock está construido casi enteramente alrededor de este modelo (ver §4).

---

## 2. Floor plan vs. slots: ¿cuándo se asigna la mesa?

**Respuesta corta: la asignación al reservar es "blanda" (soft) en todos los líderes, y se recalcula constantemente. El host siempre tiene la última palabra.**

### OpenTable: soft assignment + "reflow"

- Al crearse la reserva, un algoritmo de **soft assignment** elige la mejor mesa según reglas en secuencia: (1) mesa libre durante todo el turn time (sin solapamiento), (2) min/max de asientos compatible, (3) que la mesa pueda cubrir el turn completo sin romper reservas posteriores, (4) preferir la opción con **menos asientos sobrantes ("seat gap") y menos mesas** — guarda las grandes para parties grandes y evita huecos muertos ([OpenTable — reflow / booking rules](https://support.opentable.com/s/article/Booking-Rules?language=en_US)).
- **Reflow**: el sistema **reasigna mesas automáticamente todo el tiempo** — cuando entra otra reserva, cuando hay cancelación o no-show, mueve reservas de mesa para compactar el plano y liberar huecos. La asignación que ves a las 17:00 puede no ser la de las 20:00.
- Si ninguna mesa satisface las reglas, la reserva queda **"huérfana" (unassigned / problem reservation)** y el staff la tiene que resolver a mano. O sea: OpenTable acepta overbooking lógico y se lo delega al host como excepción visible.

### SevenRooms: auto-assign masivo + hard assign manual

- Su algoritmo de auto-assign evalúa **hasta 10.000 opciones de asignación en 2 segundos, y re-corre con cada alta/cambio/cancelación** de reserva ([SevenRooms — table management](https://sevenrooms.com/platform/table-management/), [Medium — 9 Secrets Behind Seating](https://medium.com/@elise.musumano/9-secrets-behind-your-seating-at-the-best-restaurants-5cfd4f645e4a)).
- **Por qué los hosts lo overridean**: el algoritmo optimiza ocupación, pero no sabe de hospitalidad fina — VIPs con mesa preferida, notas especiales (aniversario junto a la ventana, cliente que odia la mesa cerca del baño), balanceo de secciones de mozos, y la lectura de "vibra" del salón. SevenRooms lo resuelve con **hard assign**: cualquier reserva se puede fijar a una mesa y el algoritmo deja de moverla; el resto sigue fluyendo alrededor ([Medium, ibíd.]). También promete distribuir mesas equitativamente entre mozos para evitar burnout ([SevenRooms — floor plan](https://sevenrooms.com/blog/restaurant-floor-plan/)).
- Patrón resultante en la vida real: **el host fija ~10–20% de las reservas (VIPs/casos especiales) y deja que el algoritmo acomode el resto**.

### Resy

Mismo esquema (asignación automática + drag & drop del host), con una queja documentada: al arrastrar una party a una mesa **la sienta automáticamente**, cosa que a algunos operadores no les gusta porque mezcla "asignar" con "sentar" ([SoftwareAdvice — Resy OS reviews](https://www.softwareadvice.com/retail/resyos-profile/)).

**Lección de diseño**: el modelo correcto es *slots calculados contra inventario de mesas + asignación blanda recalculable + hard-pin manual*. Nunca "la reserva ES la mesa" (demasiado rígido) ni "los slots son independientes de las mesas" (genera overbooking físico).

---

## 3. Waitlist de walk-ins

### Mecánica (Resy)

- El host carga la party (o el comensal se auto-carga vía QR / remote waitlist), se cotiza una espera, y al liberarse mesa el host cambia el estado a "table ready" → **SMS automático** al comensal ([Resy helpdesk — waitlist](https://helpdesk.resy.com/how-to-manage-your-waitlist:-adding-messaging-and-seating-guests-BJHGGvmId), [automated waitlist SMS](https://helpdesk.resy.com/en_us/how-to-use-automated-waitlist-sms-in-resyos-SJXzGPQIO), [mobile waitlist](https://helpdesk.resy.com/how-to-use-mobile-waitlist-rkj_bD7Iu)).
- Resy mide la **precisión de los quotes** en su Waitlist Performance report: cuántos waitlisted se sentaron, dónde se caen, qué tan exactos fueron los tiempos cotizados ([Resy — reservations](https://resy.com/join/reservations/)).
- **Resy "Notify"** (otra cosa, pero clave): waitlist de *reservas futuras* — el comensal se anota para un día/hora sin disponibilidad y recibe alerta cuando se libera por cancelación, con claim inmediato ([Resy helpdesk — Notify](https://helpdesk.resy.com/what-is-notify-and-how-does-it-work-BJrJzPQLu)). Convierte cancelaciones en mesas llenas sin trabajo del host.

### Cómo se estima la espera

- **Modo manual (la mayoría)**: el host cotiza a ojo usando benchmarks de turn time por party size. SevenRooms recomienda exactamente eso: usar los promedios históricos (pareja 1,5 h, 4-top 2 h) para predecir cuándo se libera la próxima mesa compatible ([SevenRooms — walk-in guide](https://sevenrooms.com/blog/restaurant-walk-in-waitlist-guide/)).
- **Modo ML (Yelp Waitlist, el estado del arte)**: modelo XGBoost servido online que combina el **estado actual del local** (cuánta gente en lista, qué mesas ocupadas hace cuánto) + contexto (día/hora, cierre del local) + histórico. Arquitectura: pipeline offline de entrenamiento (Spark), serving online en Python con feature-consistency estricta entre offline y online, y dark-launches para validar. Resultado publicado: **~2× más preciso que el quote del host humano** ([Yelp Engineering Blog](https://engineeringblog.yelp.com/2019/12/architecting-wait-time-estimations.html)). Detalle fino: hay **feedback loop** — el quote influye en cuándo llega la gente, lo que contamina las etiquetas; Yelp lo maneja con validación cuidadosa.
- Conversión real del waitlist (dato SevenRooms): **~82% de los anotados se sientan; ~18% abandona o cancela** antes de ser llamados ([SevenRooms — walk-in guide](https://sevenrooms.com/blog/restaurant-walk-in-waitlist-guide/)). El no-show del waitlist se maneja con un grace period corto y "pasar al siguiente" — mucho más blando que el no-show de reserva.

**Insight para MESA**: el quote de espera depende de saber (a) cuánto falta para que las mesas ocupadas terminen y (b) el turn time típico. (a) es exactamente lo que el POS sabe (curso actual, cuenta pedida) — los competidores lo estiman a ciegas o con polling de POS cada 30 s; MESA lo tiene nativo y exacto.

---

## 4. Anti no-show: hold vs. depósito vs. prepago

Datos duros de conversión/no-show (jerarquía clara):

| Mecanismo | No-show rate observado | Fuente |
|---|---|---|
| Sin política | base (3–20% según mercado; un caso extremo 30–50% semanal) | [Globe and Mail](https://www.theglobeandmail.com/business/small-business/managing/article-restaurant-owners-love-prepaid-reservations-but-will-diners-bite/) |
| Credit card hold (Tock) | **~3%** promedio; reduce no-shows hasta 16% y cancelaciones tardías 15% vs. sin política | [Tock — reduce no-shows](https://www.exploretock.com/join/resources/eliminate-no-shows-3-tock-tools/) |
| Depósito (Tock) | **~1,7%** promedio; OpenTable reporta −50% de no-shows al introducir depósitos | [Tock, ibíd.](https://www.exploretock.com/join/resources/eliminate-no-shows-3-tock-tools/), [OpenTable — payment strategies](https://www.opentable.com/restaurant-solutions/resources/3-proven-payment-strategies-reduce-no-shows/) |
| Prepago total (modelo ticket) | **~0%** — el no-show deja de ser pérdida (ya cobraste) | [Tock — prepaid](https://tock.zendesk.com/hc/en-us/articles/18413122691220-Best-Practices-for-Prepaid-Experiences) |

### Lógicas de cada mecanismo

- **CC hold (OpenTable, Resy, SevenRooms, CoverManager)**: se tokeniza la tarjeta al reservar, NO se cobra nada; si no aparece o cancela fuera de ventana, se cobra un fee fijo por persona. Política de cancelación con ventana configurable (típico 24 h). Es el default para servicio à la carte porque no espanta. Resy lo trae en todos los tiers, configurable por día/hora/party size ([restaurantvelocity](https://restaurantvelocity.com/blog/restaurant-reservation-systems/)).
- **Depósito (Tock, OpenTable)**: se cobra al reservar un % del ticket esperado (best practice Tock: **10–15% del check average**) y se descuenta de la cuenta final. Escalonado por party size — patrón real de Tock: 1–5 personas sin depósito, 6–9 → $10/persona, 10+ → $100 flat ([Tock — deposit best practices](https://tock.zendesk.com/hc/en-us/articles/5912341029140-Best-Practices-for-Deposit-Experiences)). Mejor que el hold: la plata ya está (sin tarjetas rechazadas el día D) y el compromiso psicológico es mayor.
- **Prepago (Tock, su producto entero)**: la reserva se vende como ticket de evento — menú completo + impuestos + servicio cobrados al book. Permite **dynamic pricing** ($0 el martes, $10/persona el sábado) y reventa de slots cancelados ([Tock — reservations](https://www.exploretock.com/join/reservations/)). Funciona para tasting menus y experiencias; **fracasa en à la carte** (fricción excesiva, quejas de comensales por pagar semanas antes y por la rigidez ante cambios — [CellarPass — Tock complaints](https://business.cellarpass.com/blog/top-10-complaints-guests-make-when-booking-via-tock-110425)).
- **Mixto (la práctica ganadora)**: hold para el día a día, depósito/prepago para fechas pico y experiencias (San Valentín, cena maridaje) ([OpenTable — payment strategies](https://www.opentable.com/restaurant-solutions/resources/3-proven-payment-strategies-reduce-no-shows/)).
- Complemento no-monetario: **SMS de reconfirmación** + detección de reservas simultáneas. CoverManager (pionero regional en esto: tarjeta de garantía + SMS + alerta de reservas duplicadas) reporta **no-show < 2%** en sus restaurantes ([CoverManager](https://www.covermanager.com/es/aplicaciones-de-reserva-para-restaurantes/)). Meitre usa "nivel de compromiso" variable: prepago o retención de tarjeta **según día/horario** (sábado noche sí, martes no) ([El Observador — Meitre](https://www.elobservador.com.uy/nota/meitre-una-solucion-inteligente-para-el-mundo-de-la-gastronomia-2017111500)).

**Para Argentina**: el escalonamiento por demanda de Meitre/CoverManager es el modelo correcto (pedir tarjeta para todo mata conversión en mercados sin cultura de CC-on-file; pedirla solo viernes/sábado noche y parties 6+ es vendible). MercadoPago como rail de depósitos es el equivalente local obvio.

---

## 5. CRM del comensal (SevenRooms es el referente)

### Qué guardan

Perfil unificado auto-construido con: historial de visitas y de gasto (lifetime + por visita + **itemizado** vía POS), preferencias y restricciones dietarias, notas de visitas anteriores, ocasiones (cumpleaños/aniversario), contacto, consents de marketing, loyalty tier ([SevenRooms — CRM](https://sevenrooms.com/platform/crm/), [kleene.ai — SevenRooms API](https://kleene.ai/blog/sevenrooms-api-documentation)).

### El sistema de tags (la pieza clave)

- **Tags ilimitados + Auto-tags por reglas**: "VIP", "Regular" (≥X visitas), "Big Spender" (gasto > umbral), "Wine Lover" (compra vino seguido — sale del itemizado del POS), "First Timer", "No-show previo". Los auto-tags se calculan solos con reglas sobre los datos; los manuales los pone el staff ([SevenRooms — CRM](https://sevenrooms.com/platform/crm/)).
- Con **65+ integraciones POS, cada transacción alimenta el perfil**: el gasto itemizado convierte el CRM de "agenda con notas" a "inteligencia de consumo" ([SevenRooms — restaurants](https://sevenrooms.com/restaurants/)).

### Cómo lo usa el host en servicio

- En la pantalla del servicio, cada reserva muestra el perfil: el host saluda por nombre, sabe que es la 5ª visita, que es celíaco, que la última vez se quejó de la mesa 12. El mozo sabe "dónde están sentados los high rollers" mirando el gasto en tiempo real ([SevenRooms — hotels](https://sevenrooms.com/hotels/)).
- El dato que mueve la aguja según la propia industria: **que te reconozcan** ("el mozo me recordó de la visita anterior") — un cuarto de los comensales insatisfechos no vuelve nunca ([Medium — 9 Secrets](https://medium.com/@elise.musumano/9-secrets-behind-your-seating-at-the-best-restaurants-5cfd4f645e4a)).

### Datos útiles de verdad vs. vanity

- **Útiles en servicio** (el host los lee en 3 segundos): contador de visitas, gasto promedio/lifetime, restricciones dietarias, tag VIP/no-show, nota de la última visita, ocasión de hoy. Eso es TODO lo que cabe en la tarjeta de la reserva.
- **Útiles en marketing**: segmentos por recencia/frecuencia/gasto, consumo itemizado (campaña de vinos a wine lovers), cumpleaños.
- **Vanity / ruido**: scores opacos de "lealtad", docenas de campos demográficos que nadie carga, tags manuales sin reglas (mueren por inconsistencia), histórico itemizado crudo sin agregación. La crítica recurrente a SevenRooms — interfaz "cluttered", curva de aprendizaje empinada — es consecuencia directa de exponer demasiado dato sin jerarquía ([G2 — SevenRooms reviews](https://www.g2.com/products/sevenrooms/reviews), [eatapp — SevenRooms competitors](https://restaurant.eatapp.co/blog/sevenrooms-competitors)).

---

## 6. El día del servicio: la pantalla del host

### Las 3 vistas canónicas (todos convergen acá)

1. **Lista**: reservas en columnas por estado (Waitlist / Reservations / Seated / Finished). Para buscar y para ver el shift de un vistazo ([Toast Tables](https://support.toasttab.com/en/article/Using-Toast-Tables-Waitlist)).
2. **Floor plan**: el plano con estados color-coded por mesa. Para "leer el salón" y sentar.
3. **Timeline / Gantt**: mesas en filas, tiempo en columnas, reservas como rectángulos, línea vertical "ahora". **Es la vista de optimización**: muestra huecos entre reservas y conflictos, y dónde cabe un turno extra ([OpenTable — Timeline/List/Availability views](https://support.opentable.com/s/article/Spot-reservation-gaps-and-issues-with-the-Timeline-List-and-Availability-views?language=en_US)). OpenTable muestra abajo la fila de capacidad por slot de 15 min (parties + covers vs. máximo del pacing).

### Estados de la reserva (la máquina de estados)

Pipeline típico completo: `booked → confirmed (reconfirmó SMS) → arrived/partially arrived → seated → [en servicio: order placed → appetizer/starter → main → dessert → check dropped/paid] → done/left` + ramas `no-show`, `cancelled`, `late`. Los estados intra-servicio son **In-Service Statuses** configurables en SevenRooms ([SwiftPOS — SevenRooms](https://help.swiftpos.com.au/sevenrooms)); OpenTable usa la secuencia `seated, starter, main, dessert, paid` ([Lightspeed — OpenTable integration](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4415755433627-Setting-up-the-OpenTable-integration)).

### Cómo trackean el progreso SIN POS (y por qué duele)

Sin integración, **el host/mozo actualiza el estado A MANO**: pasó a entrada, pasó a principal, pidió la cuenta. En la práctica nadie lo mantiene al 100% en hora pico → el sistema cree que la mesa 7 sigue en "main" cuando ya pagaron y se fueron → el quote del waitlist y el reflow trabajan con datos viejos. Por eso SevenRooms recomienda "un responsable dedicado a mantener los estados del floor plan actualizados" ([SevenRooms — walk-in guide](https://sevenrooms.com/blog/restaurant-walk-in-waitlist-guide/)) — un costo operativo puro que existe únicamente porque el sistema de reservas no ve el POS. **Este es exactamente el dolor que MESA elimina de fábrica.**

---

## 7. Integración POS existente: qué hacen y dónde se quedan cortos

### Qué hacen hoy (OpenTable y SevenRooms, ambos con ~65-100 integraciones)

- **Match reserva↔ticket por NÚMERO DE MESA**: al sentar la party en el sistema de reservas se abre (o se vincula) la orden del POS en esa mesa; si ya hay orden abierta en la mesa, se vincula a esa ([Lightspeed — SevenRooms integration](https://k-series-support.lightspeedhq.com/hc/en-us/articles/23105693114651-Setting-up-the-SevenRooms-integration)).
- **Polling de spend cada 30 segundos** para ver gasto en vivo por mesa (SevenRooms/Lightspeed, ibíd.).
- **Auto-status por cursos**: se mapean categorías del POS a estados — al despachar el curso 4–5, la mesa pasa a "Dessert"; al cerrar el ticket pasa a "Paid" y la mesa queda libre para la próxima reserva ([SwiftPOS](https://help.swiftpos.com.au/sevenrooms), [OpenTable — course status](https://support.opentable.com/s/article/GuestCenter-POS-Integration-Automatic-Course-Status?language=en_US)).
- **Spend capture al perfil**: el ticket cerrado alimenta el CRM (gasto por visita, itemizado, propina) ([OpenTable — POS integration](https://www.opentable.com/restaurant-solutions/resources/what-is-pos-integration/)).

### Dónde se queda corta (por no ser dueños del POS)

1. **El match por número de mesa es frágil**: si el mozo abre el ticket en otra mesa, lo mueve sin vincular, o junta cuentas, el match se rompe y hay que re-vincular a mano (Lightspeed, ibíd.). Walk-ins que el host no cargó = ticket sin reserva = visita que no entra al CRM.
2. **Latencia de 30 s + mapeo manual de cursos**: la "disponibilidad en tiempo real" es en realidad polling con configuración frágil por cada POS distinto.
3. **Setup por integración**: cada par reservas↔POS requiere mapear categorías, statuses y mesas; es el punto que más se rompe en producción (los foros de soporte de Lightspeed/Toast/SwiftPOS son catálogos de estos breakages).
4. **Solo lectura del pasado**: el POS les dice qué pasó (cursos despachados, ticket cerrado) pero no participan del flujo de cobro ni del estado fino (cuenta pedida vs. impresa vs. pagada parcial). La predicción "esta mesa se libera en ~12 min" no existe en ninguno.

**MESA + COMANDA es dueño de ambos lados**: match por identidad de venta (no por número de mesa), estado instantáneo (no polling), y señales finas que ningún competidor tiene — cuenta pedida, pago parcial, comensales que se fueron. El spec de MESA ya lo formula: disponibilidad real = capacidad − mesas con ticket abierto − reservas próximas.

---

## 8. Página pública / widget: el flow del comensal

### El flow canónico (todos)

`party size → fecha → hora → ver slots → elegir slot → datos de contacto (+tarjeta si la política lo pide) → confirmación` con email/SMS de confirmación y link de cancelar/modificar.

### Fricciones conocidas

- **Cuenta obligatoria**: Resy exige cuenta con perfil completo (nombre, teléfono, email) y tarjeta guardada para la mayoría de los restaurantes populares ([TablePass — How Resy Works](https://tablepass.nyc/blog/how-resy-works-booking-guide)). Esto funciona para Resy-la-marca (su red de diners es el producto) pero es fricción pura para el restaurante individual. La regla de conversión general: cada campo extra reduce completions; el guest checkout es esencial ([restaurantbookingsystem — booking widget](https://restaurantbookingsystem.com/academy/glossary/booking-widget/), [tablein — booking widgets](https://www.tablein.com/blog/restaurant-booking-widget-examples)).
- **Pedir tarjeta**: la fricción más grande del flow; Tock es el caso extremo (pago total semanas antes → abandono y quejas documentadas — [CellarPass](https://business.cellarpass.com/blog/top-10-complaints-guests-made-when-booking-via-tock-110425)).
- **Mobile**: >60% del tráfico de webs de restaurantes es mobile; 1 s extra de carga ≈ −20% conversión ([ionhospitality](https://www.ionhospitality.com/2026/05/15/8-restaurant-website-must-haves-to-boost-bookings/)).
- **Slot sin disponibilidad = punto de fuga**: los que convierten mejor no muestran "no hay" — muestran alternativas (otros horarios cercanos, otro día, waitlist/Notify, o cross-selling a otro local del grupo, que CoverManager hace automático — [CoverManager](https://www.covermanager.com/es/guia-sistema-reservas-online-restaurante/)).
- Caso interesante: OpenTable introdujo **"good friction"** deliberada (pasos que modelan buen comportamiento del diner, ej. confirmar políticas de cancelación) tras años de optimizar solo facilidad ([OpenTable tech blog](https://tech.opentable.com/from-reservations-to-relationships/)) — fricción quirúrgica donde protege al restaurante, cero en el resto.

### Qué convierte

Widget embebido above-the-fold en la web propia, flow de 3 pantallas, guest checkout, mostrar pocos slots claros (no una grilla de 40), políticas visibles antes de pedir tarjeta, y confirmación instantánea por SMS/email. Reservar desde Google/Instagram/Facebook directo al mismo motor (CoverManager lo trae de fábrica; en LATAM el descubrimiento pasa por Instagram, no por un marketplace de reservas).

---

## 9. Lo que los restauranteros ODIAN y AMAN

### OpenTable

- **Aman**: la red (25M diners/mes) llena mesas que no llenarían solos; el stack de table management es el más maduro (reflow, flow controls, vistas).
- **Odian**: (1) **per-cover fees** de $1–1,50 por cubierto de la red + suscripción — un local con 500 reservas/mes paga ~$1.799/mes ([eatapp — OpenTable pricing](https://restaurant.eatapp.co/blog/opentable-pricing)); (2) **los datos del guest son de OpenTable** — email, alergias, historial: nada se va con vos si te bajás ([eatapp — alternatives](https://restaurant.eatapp.co/blog/opentable-alternatives)); (3) el programa de puntos premia al diner por ir a CUALQUIER restaurante de la red, **incluido tu competidor de enfrente** (ibíd.); (4) contratos de 3 años forzados en pandemia que dejaron resentimiento ([Bloomberg](https://www.bloomberg.com/news/features/2026-04-17/opentable-vs-resy-yelp-sevenrooms-why-some-top-restaurants-are-switching)).

### Resy

- **Aman**: pricing flat sin per-cover, "sos dueño de tus datos", SMS bidireccional ("no-shows casi cero" según reviews), marca premium + red AmEx ([Capterra — ResyOS reviews](https://www.capterra.com/p/197806/ResyOS/reviews/)).
- **Odian**: glitches y updates frecuentes; **pacing solo por covers** (quieren pacear por mesas); el drag&drop que sienta automáticamente; soporte flojo post-adquisición AmEx; a algunos les duplicaron el precio ([SoftwareAdvice — Resy OS](https://www.softwareadvice.com/retail/resyos-profile/)).

### SevenRooms

- **Aman**: EL CRM (perfiles auto-construidos con gasto itemizado del POS, auto-tags), marketing automation, auto-assign que maximiza covers, sin marketplace = sin fee por cubierto y datos 100% propios.
- **Odian**: **precio** ($499+/mes, inalcanzable para independientes) y **curva de aprendizaje empinada / UI recargada** — "es como un Android: complejo, menos intuitivo" ([G2 — SevenRooms reviews](https://www.g2.com/products/sevenrooms/reviews), [Capterra](https://www.capterra.com/p/165480/SevenRooms/reviews/)). Resumen lapidario de un análisis: "no es un sistema de reservas, es un CRM con reservas atornilladas" ([restaurantvelocity](https://restaurantvelocity.com/blog/restaurant-reservation-systems/)).

### Tock

- **Aman**: prepago = no-shows ~0 y cash flow adelantado; un operador pasó de 30–50% de no-show semanal a cero ([Globe and Mail](https://www.theglobeandmail.com/business/small-business/managing/article-restaurant-owners-love-prepaid-reservations-but-will-diners-bite/)); dynamic pricing por demanda.
- **Odian**: rígido para à la carte y cambios de último momento; contratos con auto-renovación "predatoria" en letra chica y ventas agresivas ([BBB — Tock complaints](https://www.bbb.org/us/il/chicago/profile/restaurants/tock-0654-90012599/complaints)); fricción que espanta comensales ([CellarPass](https://business.cellarpass.com/blog/top-10-complaints-guests-make-when-booking-via-tock-110425)).

### CoverManager / Meitre (referencia regional)

- **CoverManager — aman**: sin comisión por cubierto, anti no-show probado (<2%), reservas desde Google/IG/FB, cross-selling entre locales del grupo. **Odian**: personalización limitada, necesita configuración correcta y supervisión continua; pensado más para grupos que para el independiente ([paragastronomicos — comparación](https://paragastronomicos.com/comparacion)).
- **Meitre — aman**: demanda predictiva (algoritmo sobre histórico de reservas) y garantías flexibles por día/hora; pensado para alta gama. **Odian**: implementación compleja, curva de aprendizaje que frena al equipo, funcionalidades subutilizadas, poco alcance como canal de demanda ([paragastronomicos, ibíd.](https://paragastronomicos.com/comparacion), [El Observador](https://www.elobservador.com.uy/nota/meitre-una-solucion-inteligente-para-el-mundo-de-la-gastronomia-2017111500)).

**Patrón transversal**: nadie odia la lógica de reservas de nadie — odian (a) fees por cubierto, (b) no ser dueños de sus datos, (c) complejidad/curva de aprendizaje, (d) rigidez contractual. Las cuatro son evitables por diseño.

---

## Lecciones para MESA

### Qué imitar (es el estándar por una razón)

1. **El modelo de 4 capas**: shifts → turn times por party size → pacing de covers por slot de 15 min → inventario de mesas con min/max y combinaciones. Es el lenguaje que cualquier operador que vio OpenTable/Resy ya habla. No inventar otro modelo conceptual.
2. **Soft assignment + reflow + hard-pin**: asignación automática de mesa recalculable en cada cambio, con regla "menos asientos sobrantes, menos mesas, menos huecos", reservas huérfanas visibles cuando no cierra, y pin manual para VIPs que el algoritmo nunca mueve.
3. **Las 3 vistas del host**: lista / floor plan / timeline con línea de "ahora" y fila de capacidad por slot. La timeline es la vista de optimización — no es opcional.
4. **Máquina de estados completa** con ramas no-show/cancelled/late, y SMS automático en los puntos clave (confirmación, recordatorio, mesa lista).
5. **Anti no-show escalonado estilo Meitre/CoverManager**: sin garantía entre semana, tarjeta/seña solo viernes-sábado noche y parties 6+, depósito (10–15% del ticket esperado, vía MercadoPago) para fechas pico y eventos. SMS de reconfirmación siempre. Jerarquía probada: depósito (1,7% no-show) > hold (3%) > nada.
6. **Auto-tags por reglas** sobre datos que ya existen (visitas, gasto, no-shows) en vez de tags manuales que mueren solos.
7. **Notify estilo Resy**: lista de espera para fechas llenas que convierte cancelaciones automáticamente.

### Qué evitar (los errores documentados de los líderes)

1. **No cobrar por cubierto ni secuestrar los datos del guest** — son los dos motivos #1 de churn de OpenTable. El CRM es del restaurante, exportable, punto.
2. **No exigir cuenta al comensal para reservar** (error Resy): guest checkout con nombre+teléfono; la cuenta es opcional y posterior.
3. **No hacer del prepago el modelo central** (error Tock para à la carte): es una herramienta para fechas/eventos, no el default.
4. **No exponer toda la complejidad** (error SevenRooms): defaults profesionales out-of-the-box (turn times sugeridos por party size, pacing default tipo "30 covers/15 min" escalado a la capacidad del local) y configuración avanzada escondida. El host nuevo tiene que operar el día 1 sin training.
5. **No permitir pacear solo por covers** (queja Resy): ofrecer límite por covers Y por parties por slot desde el día 1 — es barato de construir ahora y caro después.
6. **No mezclar "asignar mesa" con "sentar"** en la UI (queja Resy del drag&drop).

### Qué hacer MEJOR gracias a la integración nativa con el POS (el foso)

1. **Disponibilidad verdadera en tiempo real**: los competidores calculan slots contra reservas + turn times estimados; MESA calcula contra **mesas con ticket abierto en COMANDA ahora mismo**. "¿Hay lugar ahora?" = capacidad − tickets abiertos − reservas próximas. Nadie más puede ofrecer esto sin polling frágil cada 30 s.
2. **Estados de servicio automáticos sin trabajo del host**: lo que SevenRooms logra con mapeo manual de cursos por cada POS + un empleado dedicado a actualizar estados, MESA lo tiene gratis: COMANDA sabe el instante exacto de cada curso, cuenta pedida y pago. El host de MESA **nunca** actualiza un estado intra-servicio a mano.
3. **Turn times que se calibran solos**: medir la duración real de cada venta por party size/turno/día desde COMANDA y proponer ajustes ("tus mesas de 2 los viernes duran 78 min, tenés configurado 105 — podés ofrecer un turno más"). Los competidores hacen estimar esto a mano al dueño.
4. **Predicción de liberación de mesa**: COMANDA sabe que la mesa 7 ya pidió la cuenta → "se libera en ~10 min" → quotes de waitlist precisos (el approach ML de Yelp necesita un modelo entero para inferir lo que el POS sabe con certeza) y reflow proactivo.
5. **Match reserva↔ticket por identidad, no por número de mesa**: al sentar desde MESA se abre la venta en COMANDA ya vinculada (guest, party size, tags, ocasión impresos en el contexto del mozo). Cero breakage por mesas movidas o cuentas unidas — el dolor #1 de las integraciones de terceros.
6. **CRM con consumo itemizado de fábrica**: el diferencial premium de SevenRooms (65+ integraciones para lograrlo) es una query interna para MESA. Auto-tags por consumo real ("pide vino siempre", "ticket promedio $X") + gasto en vivo por mesa para el manager, sin configurar nada.
7. **Walk-ins también entran al CRM**: ticket sin reserva = visita registrada igual (si se identifica al guest en el pago/fidelidad de COMANDA). Los competidores pierden todas las visitas que no pasaron por el host stand.
8. **Cierre del loop financiero**: la seña cobrada en MESA aparece como pago a cuenta en el ticket de COMANDA y en la caja de PASE — los competidores cobran depósitos en un sistema y el restaurante los re-concilia a mano contra el POS.

### Riesgo a vigilar

La ventaja de MESA es de **integración**, no de demanda: OpenTable/Resy traen comensales; MESA (como SevenRooms, CoverManager) depende de los canales propios del restaurante. El widget + reservas desde Google/Instagram + Notify tienen que ser excelentes desde el día 1, porque no hay marketplace que disimule un funnel flojo.

---

## Fuentes principales

- OpenTable Support: [reflow/booking rules](https://support.opentable.com/s/article/Booking-Rules?language=en_US) · [turn times](https://support.opentable.com/s/article/turn-times?language=en_US) · [flow controls](https://support.opentable.com/s/article/flow-controls?language=en_US) · [availability planning](https://support.opentable.com/s/article/Online-Availability-Settings?language=en_US) · [Timeline/List/Availability views](https://support.opentable.com/s/article/Spot-reservation-gaps-and-issues-with-the-Timeline-List-and-Availability-views?language=en_US) · [POS course status](https://support.opentable.com/s/article/GuestCenter-POS-Integration-Automatic-Course-Status?language=en_US)
- OpenTable: [payment strategies vs no-shows](https://www.opentable.com/restaurant-solutions/resources/3-proven-payment-strategies-reduce-no-shows/) · [what is POS integration](https://www.opentable.com/restaurant-solutions/resources/what-is-pos-integration/) · [tech blog — good friction](https://tech.opentable.com/from-reservations-to-relationships/)
- Resy helpdesk: [waitlist](https://helpdesk.resy.com/how-to-manage-your-waitlist:-adding-messaging-and-seating-guests-BJHGGvmId) · [automated SMS](https://helpdesk.resy.com/en_us/how-to-use-automated-waitlist-sms-in-resyos-SJXzGPQIO) · [Notify](https://helpdesk.resy.com/what-is-notify-and-how-does-it-work-BJrJzPQLu) · [pacing](https://helpdesk.resy.com/how-to-edit-table-availability-and-pacing-in-a-shift-S1T3bPXLd) · [fixed seatings](https://helpdesk.resy.com/how-to-setup-fixed-seating-times-for-your-shifts-H1v2ZPm8O)
- SevenRooms: [table management](https://sevenrooms.com/platform/table-management/) · [CRM](https://sevenrooms.com/platform/crm/) · [walk-in/waitlist guide](https://sevenrooms.com/blog/restaurant-walk-in-waitlist-guide/) · [floor plan](https://sevenrooms.com/blog/restaurant-floor-plan/) · [Peoplevine — access rules](https://help.peoplevinehelp.com/en/articles/4564380-access-rules-in-seven-rooms)
- Integraciones POS: [Lightspeed K-series ↔ SevenRooms](https://k-series-support.lightspeedhq.com/hc/en-us/articles/23105693114651-Setting-up-the-SevenRooms-integration) · [SwiftPOS ↔ SevenRooms](https://help.swiftpos.com.au/sevenrooms) · [Lightspeed ↔ OpenTable](https://k-series-support.lightspeedhq.com/hc/en-us/articles/4415755433627-Setting-up-the-OpenTable-integration)
- Tock: [reduce no-shows](https://www.exploretock.com/join/resources/eliminate-no-shows-3-tock-tools/) · [deposit best practices](https://tock.zendesk.com/hc/en-us/articles/5912341029140-Best-Practices-for-Deposit-Experiences) · [prepaid best practices](https://tock.zendesk.com/hc/en-us/articles/18413122691220-Best-Practices-for-Prepaid-Experiences) · [BBB complaints](https://www.bbb.org/us/il/chicago/profile/restaurants/tock-0654-90012599/complaints) · [CellarPass — guest complaints](https://business.cellarpass.com/blog/top-10-complaints-guests-make-when-booking-via-tock-110425) · [Globe and Mail — prepaid](https://www.theglobeandmail.com/business/small-business/managing/article-restaurant-owners-love-prepaid-reservations-but-will-diners-bite/)
- Yelp: [engineering blog — wait time predictions](https://engineeringblog.yelp.com/2019/12/architecting-wait-time-estimations.html)
- Reviews/análisis: [G2 SevenRooms](https://www.g2.com/products/sevenrooms/reviews) · [Capterra ResyOS](https://www.capterra.com/p/197806/ResyOS/reviews/) · [SoftwareAdvice Resy OS](https://www.softwareadvice.com/retail/resyos-profile/) · [eatapp — OpenTable vs Resy](https://restaurant.eatapp.co/blog/opentable-vs-resy) · [eatapp — OpenTable alternatives](https://restaurant.eatapp.co/blog/opentable-alternatives) · [restaurantvelocity — reservation systems](https://restaurantvelocity.com/blog/restaurant-reservation-systems/) · [Bloomberg — why top restaurants are switching](https://www.bloomberg.com/news/features/2026-04-17/opentable-vs-resy-yelp-sevenrooms-why-some-top-restaurants-are-switching)
- Regionales: [CoverManager](https://www.covermanager.com/es/guia-sistema-reservas-online-restaurante/) · [paragastronomicos — comparación](https://paragastronomicos.com/comparacion) · [El Observador — Meitre](https://www.elobservador.com.uy/nota/meitre-una-solucion-inteligente-para-el-mundo-de-la-gastronomia-2017111500)
- Otros: [Medium — 9 Secrets Behind Seating](https://medium.com/@elise.musumano/9-secrets-behind-your-seating-at-the-best-restaurants-5cfd4f645e4a) · [Toast Tables](https://support.toasttab.com/en/article/Using-Toast-Tables-Waitlist) · [Tasting Table — time limits](https://www.tastingtable.com/1645809/restaurant-reservation-time-limit/) · [tablein — booking widgets](https://www.tablein.com/blog/restaurant-booking-widget-examples)
