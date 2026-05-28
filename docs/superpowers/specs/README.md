# Rediseño PASE+COMANDA — Índice de Specs

**Fecha:** 2026-05-28
**Sesión:** brainstorming maratónica madrugada/mañana 28-may
**Total:** 8 specs · ~7.335 líneas documentadas · ~80 tablas nuevas/modificadas · ~60 RPCs nuevas
**Estado:** 🟡 SPECS COMPLETOS — implementación diferida (esperando plan holístico)

---

## Resumen ejecutivo

Sesión de brainstorming sistemático para rediseñar las áreas críticas del sistema PASE+COMANDA antes de implementar. Se aplicó la metodología del skill `superpowers:brainstorming` con benchmarks de 14+ sistemas profesionales del mercado (Toast, Square, Lightspeed, R365, MarketMan, Apicbase, Tango, Bejerman, Nominapp, Buk, Gusto, Rippling, Deputy, MarginEdge, xtraCHEF).

**Decisiones default profesionales aplicadas** alineadas con el benchmark — el sistema queda diseñado como Toast/R365 para que sea **familiar y vendible a otros clientes** después de Neko.

**~50% del código actual no se toca** (auth, multi-tenant, multi-local, caja core, EERR base devengada, conciliación MP, lector IA, sistema solicitudes, etc.). Los specs son una mezcla de REFACTOR + MOVER UI + FEATURES nuevas.

---

## Los 8 specs

### 📌 Spec #1 — RRHH (Equipo)
**Archivo:** [`2026-05-28-rrhh-rediseno-design.md`](./2026-05-28-rrhh-rediseno-design.md)
**Tamaño:** ~600 LOC · 30% nuevo · 50% refactor · 20% sin tocar

**Cambio central:** modelo "slot mensual por empleado" → "eventos discretos con fecha + liquidación abierta como contenedor" (modelo Tango/Bejerman/Gusto).

**Lo que resuelve:**
- Pagos quincenales / semanales / diarios / mensuales coexisten sin duplicar trabajo
- Vista calendario para encargados (futuro cercano)
- Preparado para fichero biométrico (futuro lejano) sin rehacer el modelo
- Dashboard "qué tenés que cerrar HOY"
- Pay Run como pantalla de REVISIÓN (no de carga desde cero)

**Tablas nuevas:** `rrhh_eventos`, `rrhh_pay_calendars`, `rrhh_liquidaciones_v2` con state machine
**Lo más importante para revisar:** las 4 modalidades de pago (diario/semanal/quincenal/mensual) y cómo se cierran.

---

### 📌 Spec #2 — Catálogo + Recetas + Insumos
**Archivo:** [`2026-05-28-catalogo-recetas-rediseno.md`](./2026-05-28-catalogo-recetas-rediseno.md)
**Tamaño:** ~850 LOC · 40% nuevo · 30% refactor · 40% mueve UI COMANDA→PASE

**Cambio central:** catálogo + recetas + insumos vivían en COMANDA, ahora se mueve a PASE únicamente. COMANDA solo consume vía Supabase Realtime.

**Decisión arquitectónica clave:** alinear con Toast/Square/R365 — el catálogo NUNCA se administra desde POS. Cajeros NO ven costos. Recetas con sub-recetas anidadas + yield % (modelo 3 capas Yield/Prep/MI).

**Lo que resuelve:**
- Cocina central (Maneki produce, los demás consumen vía transferencias)
- Sub-recetas reusables (cambiá receta de teriyaki en 1 lugar → impacta los 8 platos)
- Yield % por nivel (sushi: salmón 60%, arroz 250%) → CMV real
- Importador de recetas con Claude IA (foto/Excel/PDF → estructura editable)

**Tablas nuevas:** `transferencias_internas`, `ventas_no_catalogadas`, `recetas_import_drafts` + 11 pantallas movidas
**Lo más importante para revisar:** las 22 decisiones default en sección 2.4 (modificadores, versioning, combos, Open Item).

---

### 📌 Spec #3 — Stock + CMV + AvT
**Archivo:** [`2026-05-28-stock-cmv-avt-rediseno.md`](./2026-05-28-stock-cmv-avt-rediseno.md)
**Tamaño:** ~1030 LOC · **70% nuevo** · 20% refactor · 10% sin tocar
**⭐ EL MÁS IMPORTANTE PARA TU ROI**

**Cambio central:** stock fantasma → ledger inmutable `movimientos_stock` + cache derivado `stock_actual` (mismo patrón saldos_caja, deuda C4-F16 cerrada).

**Lo que resuelve:**
- Auto-depleción al vender (POS dispara INSERTs por cada insumo de la receta, resolución recursiva)
- Conteo móvil "shelf-to-sheet" + blind count + partial count
- Mermas con motivo enum obligatorio
- **AvT dashboard como KPI estrella** (Actual vs Theoretical — la diferencia entre stock real y teórico)
- Compras sugeridas fill-to-par con lead time
- Producción de PREPs con yield real medido

**Tablas nuevas:** `movimientos_stock`, `stock_actual`, `mermas`, `conteos`, `count_sheets`, `par_levels`, `producciones`
**Lo más importante para revisar:** el AvT dashboard (sección 5.2) — es el reporte que vas a mirar todos los lunes.

---

### 📌 Spec #4 — Compras + Proveedores + AP
**Archivo:** [`2026-05-28-compras-proveedores-ap-rediseno.md`](./2026-05-28-compras-proveedores-ap-rediseno.md)
**Tamaño:** ~870 LOC · 60% nuevo · 30% refactor · 10% sin tocar

**Cambio central:** cierra el loop **compra → precio MP → costo receta → CMV → AvT**. Hoy no hay OC (Orden de Compra), no hay 3-way match, el precio de las materias primas no se actualiza automático al cargar factura.

**Lo que resuelve:**
- Workflow OC → Remito → Factura → Pago con 3-way match (tolerancia ±2%)
- Auto-update precio_actual MP al cargar factura aprobada
- Approval workflow para facturas grandes o con discrepancia
- Vendor catalog con códigos del proveedor + historial precios
- Lector IA integrado al flow (no estandalone aparte)
- Vendor scorecard (5 métricas: reliability, quality, price stability, etc.)

**Tablas nuevas:** `ordenes_compra`, `ordenes_compra_items`, `vendor_catalog`, `vendor_catalog_precio_history`
**Lo más importante para revisar:** flow del wizard "Nueva OC" (sección 5.2) y la integración del lector IA.

---

### 📌 Spec #5 — Caja + Finanzas + P&L
**Archivo:** [`2026-05-28-caja-finanzas-pl-rediseno.md`](./2026-05-28-caja-finanzas-pl-rediseno.md)
**Tamaño:** ~1090 LOC · **75% nuevo** · 15% refactor · 10% sin tocar
**⭐ EL QUE MÁS VALOR AGREGA AL DUEÑO**

**Cambio central:** la parte de Caja ya está bien (no se toca). Se agrega encima la **capa analítica** que el dueño de restaurante mira para decidir.

**Lo que resuelve:**
- **Prime Cost dashboard** (CMV + Mano de Obra) — el KPI #1 de gastronomía
- **DSR** (Daily Sales Report) firmado por manager diario
- **P&L formato AAA restaurantero** (distinto al EERR contable AR genérico)
- **Cash flow forecast 30 días** con alertas de mínimos
- **Anomaly detection** con 8 reglas determinísticas
- **Menu Engineering Matrix** (Star/Puzzle/Plowhorse/Dog) con acciones sugeridas
- **Multi-local consolidation** con comparativa local vs local
- **Conciliación bancaria auto-match** con reglas configurables
- **Reportes semanales auto** por email lunes 9am

**Tablas nuevas:** `dsr_reportes`, `pl_snapshots`, `cash_flow_proyecciones`, `anomalias_detectadas`, `bank_match_rules`, `menu_engineering_snapshots`
**Lo más importante para revisar:** Prime Cost dashboard (sección 5.1) y Menu Engineering Matrix (sección 5.5).

---

### 📌 Spec #6 — Ventas + POS COMANDA refinement
**Archivo:** [`2026-05-28-ventas-pos-comanda-rediseno.md`](./2026-05-28-ventas-pos-comanda-rediseno.md)
**Tamaño:** ~875 LOC · 40% nuevo · 30% refactor · 30% sin tocar

**Cambio central:** después de los specs #1-#5, COMANDA queda mucho más liviana (perdió catálogo, recetas, CMV, reportes financieros). Este spec **refina lo que QUEDA**.

**Lo que resuelve:**
- VentaScreen consumer puro del catálogo PASE
- Cache local IndexedDB para offline-first robusto (>1h)
- 86 (agotado) sync real-time <2s cross-app
- Open Item flow completo (cajero cobra → bandeja PASE → admin formaliza)
- Sales mix events alimentan reportes Spec #5
- KDS con coursing inteligente (curso 2 espera curso 1 listo en todas las estaciones)
- Routing por estación (sushi/wok/parrilla/bar/postres)
- Manager Override remoto via push (manager aprueba desde celu)
- Tickets con templates configurables (cliente/cocina/comanda interna/precuenta)

**Tablas nuevas:** `estaciones_cocina`, `item_estaciones`, `sales_mix_events`, `ticket_templates`, `pos_offline_queue`
**10 pantallas eliminadas** de COMANDA (todas movidas a PASE)
**Lo más importante para revisar:** el coursing inteligente (sección 2.6) y la división final PASE/COMANDA (sección 2.1).

---

### 📌 Spec #7 — Permisos unificados PASE↔COMANDA
**Archivo:** [`2026-05-28-permisos-unificados-rediseno.md`](./2026-05-28-permisos-unificados-rediseno.md)
**Tamaño:** ~940 LOC · 50% nuevo · 50% refactor

**Cambio central:** el sprint del 24-may ya separó identidades de COMANDA. Este spec formaliza el modelo de permisos para que sea **coherente, auditable, vendible**.

**Lo que resuelve:**
- Catálogo unificado de ~50 slugs (PASE + COMANDA) en tabla
- 10 roles predefinidos como templates (Dueño/Encargado/Contador/Manager Local/Cajero/Mozo/Cocinero/Bartender/Rider/Solo Lectura)
- Sensibilidad de permisos (NORMAL/SENSIBLE/CRITICO) define UX
- CRITICO requiere 2FA del dueño
- Audit log de todos los cambios de permisos
- Gates explícitos para info sensible (`catalogo.ver_costos`, `finanzas.ver_pl`)

**Tablas nuevas:** `permiso_catalogo`, `permisos_history`, `solicitudes_permiso`
**Lo más importante para revisar:** los 10 roles predefinidos (sección 3.3) — ¿faltan / sobran roles para tu caso?

---

### 📌 Spec #8 — Tienda + Delivery + Marketplace
**Archivo:** [`2026-05-28-tienda-delivery-marketplace-rediseno.md`](./2026-05-28-tienda-delivery-marketplace-rediseno.md)
**Tamaño:** ~1080 LOC · 50% nuevo · 50% refactor (consolida 25 pantallas fragmentadas)

**Cambio central:** modelo unificado de pedidos. Hoy hay 25+ pantallas (TiendaHome, MarketplaceHome, PedidosHub, etc.) pero cada canal con modelo diferente.

**Lo que resuelve:**
- Tabla `pedidos` UNIFICADA (todos los canales: tienda_propia/menu_qr/rappi/pedidosya/whatsapp/telefono)
- State machine única (8 estados con transiciones documentadas)
- Tienda propia consume catálogo PASE (igual que COMANDA)
- Webhook handler genérico para Rappi/PedidosYa
- WhatsApp bot reusa motor del bot IG (Claude + Anthropic)
- Delivery propio con dispatch algorítmico (rider más cerca + menor carga + zona)
- Pickup/take-away como alternativa
- Fidelidad + cupones + reseñas integrado

**Tablas nuevas:** `pedidos`, `partner_orders_raw`, `partner_item_mapping`, `clientes`, `cupones`, `cupones_usos`, `resenas`, `reservas`, `dispatch_assignments`, `rider_zonas`
**Lo más importante para revisar:** la bandeja unificada de pedidos (sección 5.1) y el flow del rider (sección 5.3).

---

## Guía de revisión recomendada

### Orden sugerido de lectura

1. **Spec #1 (RRHH)** — el más maduro conceptualmente, te ayuda a entender el patrón "eventos discretos + state machine"
2. **Spec #2 (Catálogo + Recetas)** — base de todo lo demás, decisión arquitectónica grande (catálogo en PASE)
3. **Spec #3 (Stock + CMV + AvT)** — el más importante para tu ROI, depende del #2
4. **Spec #4 (Compras)** — cierra el loop precio → receta → CMV
5. **Spec #5 (Caja + Finanzas + P&L)** — el de más valor para vos como dueño
6. **Spec #6 (POS COMANDA)** — refinement, lectura más rápida
7. **Spec #7 (Permisos)** — más conceptual, importante para vender
8. **Spec #8 (Tienda + Delivery)** — el último, opcional si querés priorizar lo otro primero

### Qué buscar en cada spec

**Para CADA spec, preguntate:**

1. ✅ **¿La premisa central tiene sentido para Neko?**
   - Ej Spec #1: "eventos discretos" vs "slot mensual" — ¿te cierra?
   - Ej Spec #3: "AvT como KPI estrella" — ¿es lo que mirarías cada semana?

2. ⚠️ **¿Hay algo que ME OLVIDÉ?**
   - ¿Algún flow operativo que Anto hace y no está documentado?
   - ¿Algún caso edge que vas a chocar y no está cubierto?

3. 🔧 **¿Alguna decisión default no te cierra?**
   - Las "22 decisiones" del Spec #2, el "Sin aprobación versioning" del Spec #2, el "Manager Override" del Spec #6
   - Si algo es contraintuitivo para vos, dejá comment

4. 📋 **¿Las pantallas wireframe son lo que esperabas?**
   - Si algo se ve mal o falta funcionalidad, dejá comment

5. 🎯 **¿El orden de fases del despliegue tiene sentido?**
   - ¿Qué urgencia real tiene cada cosa para Neko?

### Tiempo estimado de revisión

- **Lectura rápida** de los 8: ~45-60 min (skimming)
- **Lectura profunda + notas**: 3-5 horas (probablemente 1-2 días real)
- **Revisión + discusión**: hasta 1 semana si querés pensar bien

### Cómo dejar feedback

Opción A — Comments inline en cada archivo MD (preferida):
```markdown
> 🔴 LUCAS: no me cierra X, prefiero Y
```

Opción B — Doc separado `docs/superpowers/specs/feedback-lucas.md`

Opción C — Conversación con Claude — armo otra sesión cuando termines

### Cuando termines

→ Invocar `superpowers:writing-plans` con set ajustado:
- Toma los 8 specs + tu feedback
- Arma plan holístico de implementación
- Secuencia sprints + dependencias + paralelización
- Output: plan documentado con N sprints, prioridades, milestones, estimación

---

## Stats finales

```
8 specs · 7.335 líneas de documentación profesional
~80 tablas (nuevas/modificadas/eliminadas)
~60 RPCs nuevas (SQL functions)
~25 pantallas/componentes nuevos en PASE
~10 pantallas eliminadas/movidas en COMANDA
14 sistemas profesionales benchmarked
22+ decisiones default documentadas con racional

Estimación implementación: 8-12 semanas full-time (1 dev + Claude)
Valor llega en fases (cada spec = sprint con entrega tangible)
```

## Lo que tenés HOY listo

✅ 8 specs commiteados en `docs/superpowers/specs/`
✅ Prototipos navegables en `prototipo-rrhh/`
✅ Visual companion con todas las decisiones documentadas en `.superpowers/brainstorm/`
✅ Memoria persistente actualizada en `~/.claude/projects/.../memory/`

---

**Cualquier duda, comment, cambio, o feedback → próxima sesión retomamos y ajustamos.**
