# Toast POS — Lógica de funcionamiento y UX/UI (análisis de competidor)

> Investigación: junio 2026. Fuentes: docs oficiales (doc.toasttab.com, support.toasttab.com, central.toasttab.com), blog de Toast, G2/Capterra, Reddit (vía agregadores), artículos de consultores y benchmarks de UX.
> Objetivo: entender **cómo piensa Toast por dentro** — modelos mentales, flujos y decisiones de UX — para informar el diseño de PASE+COMANDA. No es una lista de features ni de precios.

---

## 1. Modelo de menú: la jerarquía de 5 niveles + modificadores como "stickers"

### La estructura

Toast organiza todo el catálogo en una jerarquía estricta:

```
Menu (Comida / Bebida / Almuerzo / Happy Hour)
 └── Menu Group (Entradas, Ensaladas, Postres)
      └── Subgroup (opcional, hasta 3 niveles: "Vinos por copa" / "por botella")
           └── Item (Milanesa napolitana)
                └── Modifier Group (Punto de cocción, Guarnición)
                     └── Modifier (Jugoso / A punto / Bien cocido)
```

- **Menus** son el nivel superior y representan categorías de oferta (Food, Drinks, Lunch, Dinner, Happy Hour). Los **Groups** son la segunda capa (Appetizers, Salads...), y los **Items** caen dentro de groups o subgroups. Fuente: [Understanding the menu hierarchy](https://doc.toasttab.com/doc/platformguide/adminUnderstandingTheMenuHierarchy.html), [Menus, Menu Groups, and Subgroups](https://support.toasttab.com/en/article/Menus-Menu-Groups-and-Subgroups).
- Los subgroups se limitan a **3 niveles de anidamiento** explícitamente "para evitar exceso de clicks del usuario" — Toast pone un techo a la profundidad por UX, no por técnica. Fuente: [Understanding the menu hierarchy](https://doc.toasttab.com/doc/platformguide/adminUnderstandingTheMenuHierarchy.html).

### Modificadores: attachables a cualquier nivel (el insight clave)

La doc oficial usa la metáfora de **"sticky notes que podés pegar al archivero entero, a una carpeta, o a un documento individual"**: un Modifier Group se puede adjuntar a nivel **Group** (aplica a todos los items del grupo), **Subgroup** o **Item**. Fuente: [Creating Modifier Groups and Modifiers](https://support.toasttab.com/en/article/Creating-Modifier-Groups-and-Modifiers-1492803987509).

- Esto significa que "Punto de cocción" se define UNA vez y se pega al grupo "Carnes" entero; no se duplica por item.
- Soporta **modificadores anidados** (un modifier "Side Salad" que a su vez abre el grupo "Aderezo") — solo en el workflow clásico, no en el builder nuevo. Fuente: [Understanding the menu hierarchy](https://doc.toasttab.com/doc/platformguide/adminUnderstandingTheMenuHierarchy.html).
- Configuración por grupo: requerido/opcional, **mín/máx de selecciones**, si un modifier puede elegirse más de una vez, modificadores **default** pre-seleccionados, y prioridad de display. El mínimo solo aparece si el grupo es "required"; existe un tercer estado "optional – force show" (opcional pero se muestra igual en el POS). Fuente: [Configure Modifier Behavior](https://support.toasttab.com/en/article/Required-Optional-Modifiers), [Set Up and Use Modifier Multi-Select](https://central.toasttab.com/s/article/Setting-up-limited-and-free-modifiers-for-an-item).
- Orden de aparición en el POS: **primero los required, después los opcionales con prompt, después los opcionales sin prompt**. Fuente: [Understanding modifier group display order](https://doc.toasttab.com/doc/platformguide/adminUnderstandingModifierGroupDisplay.html).
- A nivel canal: si un grupo required es visible en un canal, **el pedido falla si no se eligió un modifier** — la obligatoriedad viaja con el menú a online ordering y 3rd parties. Fuente: [Configure Modifier Behavior](https://support.toasttab.com/en/article/Required-Optional-Modifiers).

### Un solo árbol para TODOS los canales + visibilidad por canal

Decisión arquitectónica central: **"la estructura que creás la usan todos los productos Toast"** (POS, Online Ordering, Kiosk, apps de terceros). No hay un menú para el salón y otro para delivery: hay UN árbol y cada menú/grupo/item tiene un setting de **Channel visibility** con checkboxes: POS / Kiosk + Order & Pay / Toast Online Ordering + app Local / Ordering partners (DoorDash, UberEats, Grubhub). Fuentes: [Understanding the menu hierarchy](https://doc.toasttab.com/doc/platformguide/adminUnderstandingTheMenuHierarchy.html), [Set Menu Visibility in the Menu Builder](https://support.toasttab.com/en/article/Setting-Ordering-Visibility-in-the-Menu-Builder), [Manage Your Menu Visibility Settings](https://support.toasttab.com/en/article/How-to-Manage-your-Menu-Visibility-Settings).

### Precios: estrategias por entidad, con herencia

Toast no tiene "un precio por item": tiene **estrategias de pricing** elegibles por entidad ([Toast pricing features](https://doc.toasttab.com/doc/platformguide/adminToastPosPricingFeatures.html)):

- **Base price** — precio fijo.
- **Size pricing** — precio por tamaño (el "tamaño" es un modifier group especial).
- **Open pricing** — el precio se tipea en el POS al momento de vender.
- **Menu-specific price** — el MISMO item vale $5 en el menú Lunch y $7 en el menú Dinner. El precio depende de POR DÓNDE entraste al item. Fuente: [Menu-specific price](https://doc.toasttab.com/doc/platformguide/adminMenuSpecificPrice.html).
- **Time-specific price** — precio por franja horaria ($10 de 12 a 14, $12 el resto del día), con base price como fallback. Es el mecanismo del happy hour sin duplicar items. Fuente: [Time-specific price](https://doc.toasttab.com/doc/platformguide/adminTimeSpecificPrice.html).
- **Limitación real**: Toast Online Ordering NO soporta time/open prices — la matriz de qué canal soporta qué estrategia es una fuente de sorpresas. Fuente: [Toast product channel support for advanced pricing features](https://doc.toasttab.com/doc/platformguide/adminToastProductChannelSupportForAdvancedPricingFeatures.html).

### Versioning multi-local: corporativo es dueño del item, el local es dueño de su versión del grupo

Para cadenas, Toast separa **ownership de item vs ownership de versión**: corporativo define los items (precio, specs, nadie más los toca); cada local tiene su **versión** del menu group y decide qué items corporativos incluye (el local Northeast saca el shrimp, el Southeast saca la langosta — mismos items subyacentes). El manager local puede armar su carta pero NO puede editar el item. Fuente: [Versioning at the menu group and modifier group level](https://doc.toasttab.com/doc/platformguide/versioningAtTheMenuGroupAndModifierGroupLevel.html).

### Por qué este modelo, y qué problemas reporta la gente

**Por qué**: (a) define una vez, hereda hacia abajo (modifiers y settings pegados a nivel grupo); (b) un solo source of truth para N canales; (c) el precio es función del contexto (menú, hora, canal), no un atributo plano del item; (d) escala a cadenas con el versioning.

**Problemas reportados**:
- **Dos editores conviviendo**: Toast tiene el **Menu Builder** nuevo ("más fácil de usar") y las **classic menu pages** viejas — y la doc admite que "hay piezas de configuración que todavía no existen en el menu builder" (nested modifiers, barcode setup) y obligan a saltar al editor legacy. La transición de UI a mitad de camino confunde. Fuente: [Menu builder and the classic menu details pages](https://doc.toasttab.com/doc/platformguide/adminBasicMenuBuilderAndTheLegacyMenuDetailsPages.html).
- La herencia multinivel es potente pero opaca: para edición masiva existe una pantalla aparte de **Advanced Properties** (grilla tipo Excel de todo el menú) que es la válvula de escape cuando la jerarquía te queda chica. Fuente: [Use Advanced Properties to Edit Your Menu in Bulk](https://central.toasttab.com/s/article/Advanced-Properties-1493048870996).
- El modelo save→publish (ver §3) agrega un paso extra que los usuarios novatos olvidan: "guardé y no aparece en el POS".

---

## 2. Flujo del mozo/cajero en el POS

### Layout del order screen: cheque a la izquierda, menú a la derecha

Pantalla partida: **check details a la izquierda, menú navegable a la derecha**. En el panel del cheque viven mesa, nombre de tab, mozo asignado, service charge, Split, Discount, guest count; lo infrecuente (tax exempt, lookup check, void order) va a un **overflow menu de 3 puntitos**. Fuente: [Manage Orders With Toast POS](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens).

- **Dos modos de servicio** con el mismo esqueleto: **Quick Order** (fast-casual: el cheque muestra solo lo esencial, Split y Guest count se van al overflow) y **Table Order** (full-service: más acciones rápidas arriba, como transferir cheque a otro mozo). El restaurante elige el modo, la pantalla se adapta. Fuente: ídem.
- En el handheld **Toast Go**, Hold/Stay/Send quedan **fijos abajo**, el header se colapsa automáticamente al cargar items, y Print/Pay están siempre visibles — diseño para pulgar y para no perder el contexto. Fuente: ídem.
- Existe además **Open View**: un workflow alternativo donde items y modifiers están todos en una sola pantalla "para cargar pedidos complicados a velocidad rapid-fire" — pensado para bares/cafés de alto volumen. Fuente: ídem + [Everything Toast announced Fall 2024](https://pos.toasttab.com/news/everything-toast-announced-fall-product-release-2024).

### Taps para lo frecuente

Carga típica: **tap 1** categoría → **tap 2** item → los modifiers required aparecen solos abajo → confirmar. Los modificadores forzados no requieren navegación: el POS te los planta en pantalla y no te deja avanzar sin resolverlos; los opcionales con "POS prompt" aparecen después, los opcionales sin prompt hay que ir a buscarlos. Fuentes: [Manage Orders With Toast POS](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens), [Configure Modifier Behavior](https://support.toasttab.com/en/article/Required-Optional-Modifiers).

En el rediseño 2024 Toast explicitó la filosofía: **"en una industria donde la memoria muscular lo es todo"**, los principios fueron menos taps y no romper hábitos — el menú arranca abierto para cargar más rápido (colapsable para ver el cheque), optimizaron order-by-seat "para reducir el número de taps", y los botones Hold/Stay/Send quedaron **fijos en el footer** explícitamente para "preservar la memoria muscular" y mantener consistencia con la experiencia clásica. Cambiaron íconos por **texto** en Service charge/Discount/Split para agrandar el touch target y hacer obvia la función. Fuente: [Fall 2024 product release](https://pos.toasttab.com/news/everything-toast-announced-fall-product-release-2024), [Innovation Hub Fall 2024](https://pos.toasttab.com/innovation-hub/fall-2024).

### Hold / Stay / Send: control de ritmo en manos del mozo

Tres botones bajo el cheque (solo si se habilitan en Toast Web):
- **Send** manda a cocina; **Hold** retiene el item (no se dispara hasta seleccionarlo y mandarlo); **Stay** lo deja en el cheque sin enviar. Los items enviados se pintan de **amarillo** — estado visible de un vistazo. El mozo puede agregar items nuevos y mandarlos **sin** soltar los que están en hold. Fuente: [Use Server Item Firing](https://support.toasttab.com/en/article/Using-Server-Item-Firing).

### Coursing: dos modelos que el restaurante elige

- **Server item firing** (manual): el mozo maneja el pacing item por item con Send/Hold/Stay ("Send courses individually").
- **Course firing** (automático): los cursos (Appetizer/Entree/Dessert, definibles) se asignan a grupos, items o modifiers; el curso siguiente puede dispararse **cuando el cocinero marca fulfilled el curso anterior en el KDS**, o por timer. El expediter puede pisar al mozo y disparar un curso manualmente. Coursing se configura **Required / Optional / Off por modo de servicio**: en Required no podés mandar la comanda si hay items sin curso. Fuentes: [Manage Course Firing Options](https://support.toasttab.com/en/article/Course-Firing-Options), [Compare Server Item Firing and Course Firing](https://support.toasttab.com/en/article/Compare-Server-Item-Firing-and-Course-Firing).

La lógica subyacente: **el pacing es un dato del pedido** (curso) separado de la estructura del menú, y el "disparo" puede ser humano (mozo), de cocina (fulfillment del curso anterior) o de reloj. Tres triggers, un solo modelo.

### Order by Seat: el asiento como dimensión del item

- Activado por default; configurable Optional/Required por modo. El cheque se muestra con **headers numerados por asiento** según el guest count; el mozo selecciona el asiento (header o botones Prev/Next seat) y todo lo que carga cae en ese asiento. Hay header especial **"Share"** para lo compartido. Items movibles de asiento incluso después de enviados. Fuente: [Use Order by Seat](https://support.toasttab.com/en/article/Order-by-Seat).
- Payoff: al cobrar, **el split por asiento es automático** — cada asiento se convierte en cheque. El costo de capturar el asiento se paga al momento del pago. Fuente: ídem.

### Split de cuenta

Tres mecanismos ([Split Checks on the POS](https://support.toasttab.com/en/article/Splitting-Checks-by-Item-1492811097734), [product update](https://updates.toasttab.com/announcements/improved-experience-for-splitting-and-moving-items)):
1. **Split evenly** en la pantalla de pago: "Split by #" — N formas, en segundos.
2. **Split por item**: modo Split con **tap-and-drop** — tocás items y los soltás en el cheque destino; se pueden partir items individuales entre N personas.
3. **Split by seat**: botón con acción "Split items between selected seats".
- Permiso separado: por default quien tiene Table Service Mode puede splitear, pero se puede exigir código de manager. Fuente: [New POS FAQ](https://support.toasttab.com/en/article/New-POS-FAQ).

### Quick Edit: editar el menú desde el POS sin ir al back-office

**Long-press en cualquier botón del menú** → "¿Entrar a Quick Edit Mode?" → desde ahí renombrar, reordenar, cambiar color de botón, y sobre todo **86'ear** (marcar agotado): dropdown Inventory → Out of Stock → el botón queda inseleccionable con un cero en la esquina, **y el agotado se propaga a web, app y agregadores de delivery al instante**. Es la operación de urgencia de servicio resuelta in situ, sin tocar Toast Web. Fuentes: [Use Quick Edit Mode on the POS](https://support.toasttab.com/en/article/Quick-Edit-Mode-1492794309057), [How to 86 Items (Lunchbox guide)](https://support.lunchbox.io/en/articles/8684459-2n-how-to-86-items-modifiers-toast).

---

## 3. Back-office (Toast Web): organización, publish, y curva de aprendizaje

### Organización

Toast Web es el cerebro de configuración: menús, empleados, reportes, dispositivos. La navegación es por dominios (Menus / Employees / Reports / Payments / Devices...) y **lo que ves depende de tus permisos** — el back-office se poda según el rol. Hay homepage con **Quick actions** (acceso directo a Menu builder, etc.). Fuentes: [Using Toast Web](https://doc.toasttab.com/doc/platformguide/adminAccessToastAdminBackend.html), [Accessing the menu builder](https://doc.toasttab.com/doc/platformguide/adminAccessingTheBasicMenuBuilder.html).

### El modelo Save → Publish (decisión central, con filo)

- **Guardar NO es publicar**: los cambios guardados no llegan a los POS ni a la API hasta que alguien aprieta **Publish**. Permite preparar cambios en borrador y soltarlos juntos; hay **scheduled publishing con change sets** (programar el rollout de la carta nueva). Fuentes: [Publishing updates to restaurant configuration](https://doc.toasttab.com/doc/platformguide/platformPublishingOverview.html), [Understanding scheduled publishing and change sets](https://doc.toasttab.com/doc/platformguide/platformUnderstandingScheduledPublishingAndChangeSets.html).
- Riesgos documentados: **no hay rollback** ("la única corrección es modificar y republicar"); el publish global puede arrastrar **cambios pendientes de otros usuarios**; en multi-local hay que asegurarse de publicar a todos los locales correctos; y si el terminal no refleja el cambio, el remedio es "Resync ALL Data" en el dispositivo. Fuentes: [Publishing overview](https://doc.toasttab.com/doc/platformguide/platformPublishingOverview.html), [Publish Changes on the POS](https://support.toasttab.com/en/article/Publish-Changes-on-the-POS).

### Curva de aprendizaje

- Sentimiento mixto en reviews: la interfaz se considera intuitiva en general, pero "toma tiempo jugar con el back-end para entenderlo a fondo" y "la riqueza de features abruma a restaurantes chicos que necesitan algo simple". Fuentes: [Capterra reviews](https://www.capterra.com/p/136301/Toast-POS/reviews/), [Sonary review](https://sonary.com/b/toast/toast+pos/), [TrustRadius](https://www.trustradius.com/products/toast-point-of-sale/reviews).
- Las partes confusas concretas: la dualidad Menu Builder/classic pages (§1), el paso publish que los novatos olvidan, y módulos periféricos flojos — un benchmark de UX 2026 documenta que la interfaz de **labor scheduling era tan inusable que operaciones la abandonaron por sistemas manuales** ("sense decay": la feature existe pero se aleja tanto del workflow real que se abandona aunque esté incluida en la suscripción). Fuente: [POS UX Benchmarking 2026 — interface-design.co.uk](https://interface-design.co.uk/blog/pos-software-ux-benchmarking-2026-the-coherence-gap/).
- El mismo benchmark destaca la fortaleza opuesta: Toast "preservó su estructura de navegación core con un ciclo de releases aditivo continuo" — los updates **no obligan a reaprender secuencias motoras** (a diferencia de Square, que arriesga rediseños visuales). La estabilidad de conditioning es la ventaja #1 de Toast en UX. Fuente: ídem.

---

## 4. Turnos de caja / cash management

### Shift review: checklist de cierre atado al clock-out

El **shift review** (= checkout / cierre de turno) es un flujo guiado que el empleado completa **antes de poder fichar la salida**, configurable required/optional en Toast Web. Pasos ([Completing shift review](https://doc.toasttab.com/doc/platformguide/platformCompletingShiftReview.html), [Shift Review Overview](https://support.toasttab.com/en/article/Shift-Review-Overview)):

1. **Cerrar todos los cheques abiertos** — el sistema muestra contadores de open/paid/closed; un cheque abierto se cobra, se anula (con manager) o se **transfiere a otro empleado**. Los cheques abiertos de turnos anteriores no aparecen en tu review.
2. **Reconciliar efectivo y propinas**: cálculo neto — ej. "$294.34 de ventas cash y $9.00 de propinas no-cash ⇒ el empleado le debe $285.34 al restaurante". El modelo es **el mozo como banco**: cobró efectivo que no es suyo y le deben propinas de tarjeta; el shift review compensa ambas en un solo número.
3. **Declarar propinas en efectivo** (opcional, con mínimo % configurable y propinas negativas permitidas si hay tip-out).
4. **Cerrar cajones asignados** y recién entonces **clock out**.

### Cash drawer: estados, lockdown y conteo ciego

- **Lockdown**: el cajón se "lockea" a un empleado — no físico, sino lógico: nadie más (salvo managers) puede operar transacciones en ese cajón. Accountability uno-a-uno. Fuente: [Cash drawer lockdown](https://doc.toasttab.com/doc/platformguide/adminCashDrawerLockdown.html).
- **Cierre**: botón Close Drawer → diálogo Close Out Balance muestra **Cash Expected** (balance inicial + entradas) vs lo contado. Fuente: [Completing shift review](https://doc.toasttab.com/doc/platformguide/platformCompletingShiftReview.html).
- **Permiso "Blind"**: el cajero cuenta el cajón **sin ver el monto esperado**, y ni siquiera ve el warning de over/short (eso lo ve solo quien tiene Full Cash Drawer). El conteo ciego es un permiso, no un modo global. Umbrales de varianza disparan aprobación de manager. Fuentes: [Set Up Cash Drawers](https://support.toasttab.com/en/article/Setting-Up-Cash-Drawers), [Cash drawer states](https://doc.toasttab.com/doc/platformguide/adminCashDrawerStates.html).
- Operaciones tipificadas del cajón: No Sale (abrir sin venta, permiso propio), Add cash, **Cash collected from server**, Cash out, **Payout** (pagar bienes/servicios desde el cajón), **Tip out**. Cada movimiento de efectivo tiene un tipo con semántica — no hay "ajuste" genérico. Fuente: [Cash drawers — platform guide](https://doc.toasttab.com/doc/platformguide/adminCashDrawers.html).

### Tip pooling (Toast Tips Manager)

- Motor de **reglas ordenadas**: "si creás más de una regla, el orden importa — Tips Manager lee tu política de arriba a abajo y calcula a medida que avanza; una propina ya distribuida en una regla anterior no está disponible para una regla posterior". Es un pipeline determinístico, no un formulario. Fuente: [Get Started With Toast Tips Manager](https://support.toasttab.com/en/article/Getting-Started-with-Toast-Tips-Manager-How-to-Pool-Share-Tips).
- **Intervalos de pooling**: por Order, por Service Period (requiere configurar Hours/Services primero) o Full Workday. **Distribución**: proporcional a horas trabajadas (pool ÷ horas totales del job = tips/hora × horas del empleado) o partes iguales. Fuentes: ídem + [Plan Your Tip Pooling Policy](https://support.toasttab.com/en/article/Common-Tip-Policies), [Pooling Tips with Other Employees](https://support.toasttab.com/en/article/Pooling-Tips-with-Other-Employees).

---

## 5. xtraCHEF / inventario: facturas → costos → recetas → food cost

### El pipeline

1. **Ingesta de facturas**: foto desde la app, upload desktop, email; integraciones directas con distribuidores grandes (Sysco, US Foods). Fuente: [xtraCHEF 101](https://support.toasttab.com/en/article/xtraCHEF-101), [dishcost.com — xtraCHEF vs MarginEdge](https://dishcost.com/blog/xtrachef-vs-marginedge).
2. **OCR + humanos**: "machine learning combinado con operadores de control de calidad" extrae proveedor, nro de factura, producto, unidad de medida, cantidad y costo línea por línea. SLA: **los datos aparecen en ~24 horas** — no es tiempo real, es un servicio de digitización asíncrono. Fuente: [Benefits of AP automation — blog Toast](https://pos.toasttab.com/blog/benefits-accounts-payable-automation-xtrachef).
3. **Item Library**: cada línea se mapea a un ítem canónico del restaurante (el paso de conciliación, equivalente a la bandeja de PASE). Fuente: [xtraCHEF Item Library](https://support.toasttab.com/en/article/xtraCHEF-Item-Review).
4. **Recipe costing**: las recetas se arman drag-and-drop sobre un "product guide" construido desde las compras históricas; el costo del plato se recalcula con cada factura nueva → plate cost, COGS, márgenes por item, y **theoretical vs actual food cost** cruzando con las ventas de Toast. Fuentes: [xtraCHEF product page](https://pos.toasttab.com/products/xtrachef), [dishcost.com](https://dishcost.com/blog/xtrachef-vs-marginedge).

### ¿Qué tan automático es? — la realidad

- **~80% de precisión** en extracción de líneas; el 20% restante es corrección manual. Fuente: [dishcost.com](https://dishcost.com/blog/xtrachef-vs-marginedge).
- El setup es la queja #1: usuarios reportan **50 a 300+ horas** de configuración ("dos meses a ~10 horas por semana"; otro abandonó tras "300 horas entre IT y yo"). G2: 3.9/10 en facilidad de setup, **3.1/10 en soporte**. Fuentes: [dishcost.com](https://dishcost.com/blog/xtrachef-vs-marginedge), [G2 xtraCHEF reviews](https://www.g2.com/products/xtrachef/reviews).
- Problemas de calidad de datos: asigna mal el vendor "incluso con 3 años de histórico", typos del OCR **crean items nuevos duplicados** que ensucian la librería, y corregir una unidad mal asignada requiere ticket a soporte. "Mapear items de factura toma una eternidad" — varios menús para mapear UNA línea. Fuentes: [G2 pros & cons](https://www.g2.com/products/xtrachef/reviews?qs=pros-and-cons), [dishcost.com](https://dishcost.com/blog/xtrachef-vs-marginedge).
- El costeo de recetas está detrás del tier pago ($199-299/mes/local) y el círculo completo costos→ventas→AvT **solo funciona dentro del ecosistema Toast**. El competidor MarginEdge (revisión humana de facturas, mejor soporte: 8.5/10) es consistentemente preferido por operadores que probaron ambos. Fuente: [dishcost.com](https://dishcost.com/blog/xtrachef-vs-marginedge).

**Lectura**: el pipeline conceptual de xtraCHEF (factura → línea → ítem canónico → receta → AvT) es exactamente el circuito A→E de PASE. Lo que falla no es el modelo sino la **ejecución del mapeo** (duplicados, unidades, correcciones bloqueadas por soporte) — la memoria de mapeo con auto-match de PASE ataca el dolor preciso que los usuarios de xtraCHEF reportan.

---

## 6. Onboarding de un local nuevo

### Dos caminos

- **Self-service**: ~**14 días**, 4 fases — Kickoff (call con el Onboarding Consultant: datos, shipping de hardware, responsabilidades) → **Build + Install** (instalación de hardware con guías interactivas, configuración back-end —empleados, taxes, descuentos, horarios—, armado de menú, training del staff vía **Toast Classroom**) → **Configuration check-in** (call de 1 hora: probar equipos, validar menú) → **Go-live** (salir de test mode y facturar de verdad, con soporte 24/7). El consultor actúa de "general contractor": guía, pero el restaurante ejecuta. Fuente: [Self-Service Onboarding Guide](https://support.toasttab.com/en/article/Self-Service-Guide).
- **Guiado (remoto/onsite)**: **4–6 semanas** con el consultor como punto de contacto que agenda especialistas. Fuente: [Remote & Onsite Onboarding Guide](https://support.toasttab.com/en/article/Remote-Onsite-Onboarding-Guide).

### El menú entra por planilla

- En el onboarding, el menú se recolecta con un **menu template** (Google Sheets/Excel) antes de construirse en el POS. Fuente: [Build Your Menu Template](https://support.toasttab.com/en/article/Building-your-Menu-Template).
- Para después, existe el **Bulk Import Tool** (CSV) con **3 plantillas**: Basic (crear items/modifier groups/modifiers con lo mínimo), Item update (actualizar nombre, precio, SKU, PLU, descripción, nombre de cocina de items existentes) y Advanced (crear y adjuntar todo + settings avanzados como color de botón). Fuente: [Bulk import tool overview](https://doc.toasttab.com/doc/platformguide/platformBulkImportToolOverview.html), [Filling out the bulk import spreadsheet](https://doc.toasttab.com/doc/platformguide/platformFillingOutTheBulkImportSpreadsheet.html).
- Hay **modo test** explícito previo al go-live, y un **sandbox de práctica** del POS para que los empleados ensayen sin tocar el sistema real. Fuentes: [Self-Service Guide](https://support.toasttab.com/en/article/Self-Service-Guide), [Toast Community — Practice POS functions](https://community.toasttab.com/t5/restaurant-operations/practice-pos-functions-at-anytime/m-p/10782).

### Quejas

- Toast "depende más de guía remota y pasos auto-dirigidos, lo que puede resultar difícil para restaurantes independientes"; "la falta de training hands-on dificulta la adaptación del staff". Fuente: [Peppr vs Toast — setup & onboarding](https://www.peppr.com/blog/peppr-vs-toast-pos-setup-onboarding) (fuente competidora, sesgo a considerar, pero consistente con reviews).

---

## 7. Lo que la gente ODIA y lo que AMA

### Odia

- **Fees que se acumulan y no coinciden con lo cotizado**: "el costo inicial fue bajo, pero las cuotas mensuales, fees ocultos y fees por cada cosa suman una factura mensual muy cara"; tasas de procesamiento "que no coinciden con lo cotizado en la venta por fees no divulgados". Fuentes: [Capterra reviews](https://www.capterra.com/p/136301/Toast-POS/reviews/), [startupowl review](https://startupowl.com/reviews/toast), [posusa.com](https://www.posusa.com/toast-pos-review/).
- **Lock-in total**: hardware propietario que solo corre Toast ("si cancelás, el equipo queda inservible"), procesamiento de pagos obligatorio con Toast sin opción de terceros, contratos de 2-3 años con auto-renovación y **early termination fee** (saldo restante o $150/mes por el término restante). Fuentes: [startupowl](https://startupowl.com/reviews/toast), [sleftpayments](https://www.sleftpayments.com/learning-hub/toast-pos-raised-fees-options-2026).
- **Soporte**: "largas esperas, llamadas sin devolver, problemas sin resolver tras múltiples contactos" — la queja más consistente en G2/Capterra/TrustRadius. Fuentes: [Capterra](https://www.capterra.com/p/136301/Toast-POS/reviews/), [TrustRadius](https://www.trustradius.com/products/toast-point-of-sale/reviews).
- **Recovery de errores operativos**: benchmark UX 2026 documenta errores de **ruteo de impresoras persistentes por 2 años** a través de escalaciones de soporte, y workflows de **void/refund que fallan a mitad de transacción generando chargebacks que Toast encima cobra**. Conclusión del benchmark: "el error recovery es donde el modelo se rompe — el camino de recuperación no solo es lento sino que genera costo downstream". Fuente: [interface-design.co.uk benchmarking](https://interface-design.co.uk/blog/pos-software-ux-benchmarking-2026-the-coherence-gap/).
- **Seguridad/phishing 2025**: oleada de cuentas secuestradas vía llamadas falsas de "soporte Toast"; MFA no obligatorio universalmente (solo para permisos financieros). Fuente: [Flyght blog — Burnt Toast](https://www.whatisflyght.com/blog/burnt-toast-when-your-pos-becomes-your-biggest-vulnerability).
- Antecedente de confianza: el **fee de $0.99 al comensal** que Toast intentó en 2023 y tuvo que revertir por backlash. Fuente: ídem.

### Ama

- **Que está hecho PARA restaurantes**: "cada feature, del armado de menú al KDS, diseñada para el ambiente restaurante"; el flujo FOH↔cocina en tiempo real reduce errores y acelera el servicio. Fuentes: [theretailexec.com](https://theretailexec.com/tools/toast-review/), [BAMS review](https://www.bams.com/blog/toast-pos-system-review/).
- **Offline mode real**: el KDS sigue recibiendo tickets de pedidos in-store durante una caída de internet o de Toast mismo ("reemplaza la impresora de backup"), y se pueden tomar pedidos y aceptar tarjetas offline con background processing. Fuentes: [Offline mode — platform guide](https://doc.toasttab.com/doc/platformguide/platformOfflineMode.html), [Prepare to Operate in Offline Mode](https://support.toasttab.com/en/article/Prepare-to-Operate-in-Offline-Mode-During-Service-Disruptions-or-Outages).
- **KDS**: visibilidad, menos modificaciones perdidas, dual-screen, **All Day View** (lista totalizada de lo pendiente en vez de mirar ticket por ticket), Recall de tickets cerrados. Fuentes: [KDS overview](https://doc.toasttab.com/doc/platformguide/platformKDSOverview.html), [Using a KDS expediter screen](https://doc.toasttab.com/doc/platformguide/adminUsingExpo.html).
- **Reporting**: insights de ventas, labor y tendencias bien valorados de forma consistente. Fuente: [softwareadvice reviews](https://www.softwareadvice.com/retail/toast-pos-profile/reviews/).
- **UI fácil para el staff** y handhelds (Toast Go) que agilizan la toma de pedidos en mesa. Fuentes: [Capterra](https://www.capterra.com/p/136301/Toast-POS/reviews/), [posusa](https://www.posusa.com/toast-pos-review/).

---

## 8. Decisiones de UX distintivas (por qué un empleado nuevo aprende rápido)

1. **Memoria muscular como principio rector explícito**: releases aditivos que nunca mueven los controles core; botones críticos (Hold/Stay/Send, Pay) anclados en posiciones fijas; cuando rediseñaron en 2024 lo dijeron textual: "preservar la memoria muscular". Fuentes: [Fall 2024 release](https://pos.toasttab.com/news/everything-toast-announced-fall-product-release-2024), [interface-design.co.uk](https://interface-design.co.uk/blog/pos-software-ux-benchmarking-2026-the-coherence-gap/).
2. **El sistema te empuja lo obligatorio**: modifiers required aparecen solos y bloquean el avance; coursing Required no deja enviar sin curso; shift review required no deja fichar salida con cheques abiertos. La regla de negocio vive en el flujo, no en un manual. Fuentes: §2 y §4.
3. **Estado visible**: items enviados en amarillo, item 86'd con cero en la esquina, RECALLED en rojo en el KDS, contadores de cheques abiertos en el shift review. Fuentes: [Using Server Item Firing](https://support.toasttab.com/en/article/Using-Server-Item-Firing), [Quick Edit Mode](https://support.toasttab.com/en/article/Quick-Edit-Mode-1492794309057), [Redisplaying tickets](https://doc.toasttab.com/doc/platformguide/adminRedisplayingTickets.html).
4. **Frecuente a un tap, infrecuente al overflow**: la jerarquía visual del check panel se decide por frecuencia de uso, y cambia según el modo (Quick Order vs Table) y el dispositivo (terminal vs Go). Fuente: [Manage Orders With Toast POS](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens).
5. **Personalización del operador sin programar**: colores y nombres de botones por entidad, modos de servicio, dark/light, Open View para barras — el mismo POS se "moldea" al tipo de local. Fuentes: [Button colors](https://doc.toasttab.com/doc/platformguide/platformButtonColors.html), [New POS Experience](https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens).
6. **Acciones de emergencia in situ**: long-press → Quick Edit → 86 propagado a todos los canales; no hace falta ir al back-office en pleno servicio. Fuente: [Quick Edit Mode](https://support.toasttab.com/en/article/Quick-Edit-Mode-1492794309057).
7. **Sandbox de práctica** para entrenar sin riesgo + Toast Classroom en el onboarding. Fuentes: [Toast Community](https://community.toasttab.com/t5/restaurant-operations/practice-pos-functions-at-anytime/m-p/10782), [Self-Service Guide](https://support.toasttab.com/en/article/Self-Service-Guide).
8. **Touch targets con texto**: el cambio 2024 de íconos a texto en Service charge/Discount/Split — legibilidad y área de toque por sobre estética minimalista. Fuente: [Fall 2024 release](https://pos.toasttab.com/news/everything-toast-announced-fall-product-release-2024).

---

## Lecciones para PASE+COMANDA

### Qué imitar

1. **Modifiers como objetos reutilizables pegables a cualquier nivel de la jerarquía** (la metáfora del sticker). Definir "Punto de cocción" una vez y heredarlo a todo el grupo Carnes elimina el 80% del mantenimiento de catálogo. Si el catálogo de COMANDA hoy ata modificadores por item, este es el upgrade estructural de mayor retorno.
2. **Mín/máx + default + "optional–force show" en grupos de modificadores**, y el ordenamiento required-primero en el POS. Es un mini-lenguaje completo que cubre todos los casos reales (elegí 1, elegí hasta 3, viene con X salvo que lo saquen).
3. **El precio como función del contexto**: menu-specific y time-specific pricing resuelven happy hour y almuerzo/cena **sin duplicar items**. Duplicar items para cambiar precio es el anti-patrón que este modelo mata.
4. **Order by seat con split automático al pagar**: capturar el asiento durante la toma hace gratis el momento más doloroso del servicio (dividir la cuenta). COMANDA ya tiene "dividir por comensal" — la lección de Toast es hacerlo **default y de fricción cero durante la carga** (headers de asiento + Next/Prev), no una pantalla aparte al final.
5. **Hold/Stay/Send + coursing con tres triggers de disparo** (mozo, fulfillment de cocina, timer) sobre un único concepto "curso". Modelo simple, cubre desde el bar hasta el fine dining.
6. **Shift review como checklist bloqueante del clock-out** con la cuenta neta "mozo como banco" (efectivo cobrado − propinas no-cash = un solo número a rendir). Y el **conteo ciego como permiso** (quien cuenta no ve lo esperado), no como modo global.
7. **86 desde el POS con long-press y propagación a todos los canales**. Operación de servicio resuelta donde ocurre.
8. **All Day View en el KDS** (totalizado de pendientes) — barato de construir, amado por cocina.
9. **Estabilidad de conditioning**: releases aditivos, controles core que nunca se mueven. Para el piloto de COMANDA: una vez que los empleados del local aprendan dónde está cada botón, **no moverlos más** — cada rediseño tiene costo de re-entrenamiento real.
10. **Sandbox/modo test para entrenar** y go-live con "salir de test mode": baja el miedo del staff nuevo y permite ensayo general (alineado con el enfoque de ensayo general que ya usa COMANDA).

### Qué evitar

1. **Dos editores de menú conviviendo** (Menu Builder nuevo vs classic pages): si se rediseña una pantalla, migrar el 100% de la funcionalidad antes de promocionarla; la convivencia a medias es la principal fuente de confusión del back-office de Toast.
2. **Publish sin rollback y con cambios ajenos arrastrados**: si PASE adopta borrador→publicar para el catálogo (útil), necesita (a) rollback o versionado, (b) publish granular por autor/cambio, no global.
3. **Matriz de soporte por canal inconsistente** (online ordering no soporta time prices): cada estrategia de pricing nueva debe funcionar en TODOS los canales o fallar en diseño, no en producción.
4. **El patrón xtraCHEF de mapeo doloroso**: duplicados creados por typos del OCR, correcciones que requieren ticket a soporte, 50-300 horas de setup. La bandeja de conciliación de PASE (memoria de mapeo + auto-match + corrección self-service) ataca exactamente esto — mantener al usuario SIEMPRE capaz de corregir unidades/vendors solo, sin soporte.
5. **Error recovery lento en flujos de plata**: voids/refunds que fallan a mitad de camino son la falla más cara de Toast según el benchmark UX. Los flujos de anulación/reintegro de COMANDA deben ser transaccionales y recuperables (ya es la dirección de los fixes de anular venta del 11-jun).
6. **Lock-in percibido como hostilidad** (hardware inutilizable al cancelar, ETF, fees sorpresa): la confianza es el activo; Toast la quemó con el fee de $0.99 y los aumentos. Transparencia total de pricing como diferencial comercial en Argentina.
7. **Soporte como cuello de botella estructural**: la queja #1 transversal. Diseñar para que el usuario nunca NECESITE soporte para operaciones de datos (self-service everywhere).

### Qué mejorar (oportunidades donde Toast es débil)

1. **Conciliación de compras**: xtraCHEF tarda 24h y acierta 80%; PASE puede ganar con feedback inmediato + memoria de mapeo que aprende del propio local (ya construido en la Pieza A).
2. **Onboarding**: 14 días self-service es el benchmark "rápido" de Toast — para locales chicos argentinos, PASE puede apuntar a horas/días con el wizard + import de planilla (imitar las 3 plantillas CSV de Toast: básica / actualización / avanzada).
3. **Back-office coherente desde el día 1**: Toast paga deuda de 10 años de módulos pegados (labor scheduling abandonado por los usuarios, dualidad de editores). PASE+COMANDA pueden ofrecer UNA lógica de navegación consistente — la "coherencia" es el gap que el benchmark 2026 señala en toda la industria.
4. **Integración POS+back-office+reservas nativa** (con MESA): Toast no tiene reservas propias de primera clase; el círculo COMANDA (mesas en vivo) + PASE (costos/finanzas) + MESA (reservas) es estructuralmente el foso que ningún player de USA cerró.
5. **Tip pooling**: el motor de reglas ordenadas de Toast es potente pero es un producto pago aparte; en Argentina el equivalente (propinas/tronco) puede ser nativo y simple.

---

### Apéndice: fuentes principales

| Tema | Fuente |
|---|---|
| Jerarquía de menú | https://doc.toasttab.com/doc/platformguide/adminUnderstandingTheMenuHierarchy.html |
| Modifier groups | https://support.toasttab.com/en/article/Creating-Modifier-Groups-and-Modifiers-1492803987509 |
| Comportamiento modifiers (req/opt/min/max) | https://support.toasttab.com/en/article/Required-Optional-Modifiers |
| Pricing strategies | https://doc.toasttab.com/doc/platformguide/adminToastPosPricingFeatures.html |
| Time-specific price | https://doc.toasttab.com/doc/platformguide/adminTimeSpecificPrice.html |
| Soporte de pricing por canal | https://doc.toasttab.com/doc/platformguide/adminToastProductChannelSupportForAdvancedPricingFeatures.html |
| Visibilidad por canal | https://support.toasttab.com/en/article/Setting-Ordering-Visibility-in-the-Menu-Builder |
| Versioning multi-local | https://doc.toasttab.com/doc/platformguide/versioningAtTheMenuGroupAndModifierGroupLevel.html |
| Menu Builder vs classic | https://doc.toasttab.com/doc/platformguide/adminBasicMenuBuilderAndTheLegacyMenuDetailsPages.html |
| Order screen | https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens |
| Server item firing | https://support.toasttab.com/en/article/Using-Server-Item-Firing |
| Course firing | https://support.toasttab.com/en/article/Course-Firing-Options |
| Order by seat | https://support.toasttab.com/en/article/Order-by-Seat |
| Split checks | https://support.toasttab.com/en/article/Splitting-Checks-by-Item-1492811097734 |
| Quick Edit / 86 | https://support.toasttab.com/en/article/Quick-Edit-Mode-1492794309057 |
| Publishing | https://doc.toasttab.com/doc/platformguide/platformPublishingOverview.html |
| Shift review | https://doc.toasttab.com/doc/platformguide/platformCompletingShiftReview.html |
| Cash drawer lockdown | https://doc.toasttab.com/doc/platformguide/adminCashDrawerLockdown.html |
| Tips Manager | https://support.toasttab.com/en/article/Getting-Started-with-Toast-Tips-Manager-How-to-Pool-Share-Tips |
| xtraCHEF 101 | https://support.toasttab.com/en/article/xtraCHEF-101 |
| xtraCHEF vs MarginEdge (quejas reales) | https://dishcost.com/blog/xtrachef-vs-marginedge |
| Onboarding self-service | https://support.toasttab.com/en/article/Self-Service-Guide |
| Bulk import | https://doc.toasttab.com/doc/platformguide/platformBulkImportToolOverview.html |
| KDS / expediter / All Day | https://doc.toasttab.com/doc/platformguide/adminUsingExpo.html |
| Offline mode | https://doc.toasttab.com/doc/platformguide/platformOfflineMode.html |
| Benchmark UX 2026 (coherencia, error recovery) | https://interface-design.co.uk/blog/pos-software-ux-benchmarking-2026-the-coherence-gap/ |
| Rediseño POS 2024 (principios) | https://pos.toasttab.com/news/everything-toast-announced-fall-product-release-2024 |
| Reviews (cons: fees, contratos, soporte) | https://www.capterra.com/p/136301/Toast-POS/reviews/ · https://startupowl.com/reviews/toast · https://www.posusa.com/toast-pos-review/ |
| Seguridad/phishing 2025 | https://www.whatisflyght.com/blog/burnt-toast-when-your-pos-becomes-your-biggest-vulnerability |
