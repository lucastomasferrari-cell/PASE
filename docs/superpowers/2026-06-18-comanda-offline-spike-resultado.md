# Spike offline COMANDA — Resultado PARCIAL + hallazgos + recomendación preliminar

**Fecha:** 2026-06-18
**Estado:** Tareas 1-4 del plan construidas (RxDB, flujo, test verde). **Validación live de criterios 2-5 + comparación PowerSync = PENDIENTE de Lucas** (requiere navegador logueado + instancia PowerSync). Este informe captura lo aprendido construyendo; la recomendación es **preliminar** hasta la validación live.

Plan: `docs/superpowers/plans/2026-06-18-comanda-offline-spike.md` · Spec: `docs/superpowers/specs/2026-06-18-comanda-offline-rebuild-design.md`.

---

## 1. Qué se construyó (commits `75ef34b`→`4af1619`)
Sandbox aislado en `packages/comanda/src/spike-offline/`, ruta dev-only `/pos/_spike-offline` (NO va a producción):
- `schema.ts` — schemas RxDB (subset real de `ventas_pos`/`ventas_pos_items`/`ventas_pos_pagos`, PK = `idempotency_uuid`).
- `db.ts` — RxDatabase local (Dexie/IndexedDB en browser; memory en tests).
- `replication.ts` — replicación pull/push contra Supabase.
- `flow.ts` — `abrirMesa` / `agregarItem` / `cobrar` contra el store LOCAL (instantáneo por construcción).
- `flow.test.ts` — **test verde**: el flujo completo corre 100% sobre el store local, sin red.
- `SpikeOfflinePage.tsx` — UI para validar los 6 criterios en el navegador.

---

## 2. Los 6 criterios — estado
| # | Criterio | Estado |
|---|---|---|
| 1 | **Instantáneo** (la red no está en el camino del toque) | ✅ **Validado por diseño + test automatizado.** El flujo escribe en RxDB local y la UI se suscribe al store; no hay `await` de red en el toque. El test prueba abrir→agregar→cobrar local-only. (Falta: confirmar "feel" en tablet real.) |
| 2 | **Offline real** (flujo completo sin internet) | ⏳ Pendiente live (DevTools Offline en el navegador). El test ya corre sin red, buena señal. |
| 3 | **Sobrevive recarga** | ⏳ Pendiente live (F5 con red OFF). RxDB persiste en IndexedDB → debería; **OJO**: para sobrevivir recarga el app-shell tiene que cargar offline → eso es la **PWA** (Fase 2), no el motor. |
| 4 | **Reconcilia sin duplicados** | ⏳ Pendiente live (Sync ON → ver filas en Supabase). El push usa upsert idempotente por `idempotency_uuid`. |
| 5 | **RLS / multi-tenant** | ⏳ Pendiente live (logueado, con tenant real). El sync usa el JWT de la sesión. |
| 6 | **Costo / operación** | RxDB = **$0** (client-side, sin servicio). PowerSync = pendiente evaluar (necesita instancia). |

---

## 3. HALLAZGOS (lo más valioso — aplican a CUALQUIER motor, no solo RxDB)
1. **Identidad offline = `idempotency_uuid`.** El `id` real es `bigint` que asigna el server → un registro creado offline no tiene `id` hasta sincronizar. El store local debe llavear por el uuid del cliente (es lo que el sistema ya intentaba con `fn_resolver_venta_id_por_uuid`).
2. **🎯 Raíz del bug `__pending_parent__`:** `ventas_pos_pagos` **NO tiene** columna `venta_idempotency_uuid` (los items SÍ). Sin ella, un **pago offline no puede referenciar una venta aún sin `id`**. **El rebuild DEBE agregar `venta_idempotency_uuid` a `ventas_pos_pagos`** (migración chica). Es la causa del bug que se veía en producción.
3. **Impedancia RPC vs tabla (decisión central del rebuild):** un motor local-first sincroniza escribiendo **tablas** directo, pero el repo manda que toda escritura de plata pase por **RPCs atómicas** (regla `no-direct-financiera-write` + lógica de negocio en las RPCs). El push del motor tiene que **llamar a las RPCs** (no upsert crudo) para no perder la lógica/validaciones. Esto vale para RxDB y para PowerSync por igual.
4. **`updated_at` existe en las 3 tablas** → sirve de checkpoint para el pull incremental. Bien.

---

## 4. Recomendación PRELIMINAR
- **El enfoque local-first es viable** y el patrón (store local + UI suscripta + sync background) funciona: el flujo corre instantáneo y local. El criterio #1 (el dolor principal de Lucas) se resuelve por construcción.
- **Los hallazgos 2 y 3 son el verdadero trabajo del rebuild** y son independientes del motor: hay que (a) agregar `venta_idempotency_uuid` a pagos, y (b) decidir que el push sincronice **vía RPCs** (atómicas, con la lógica), no por upsert directo a tablas.
- **RxDB** quedó funcionando con costo $0 y sin servicio extra — es el candidato liviano. **PowerSync** vale evaluarlo por robustez/DX, pero suma un servicio (costo + instancia). La decisión final entre RxDB y PowerSync depende de: la validación live (criterios 2-5) + el costo/fricción de PowerSync.
- **Punto clave para no repetir el error:** sea cual sea el motor, el push debe ir por RPCs y el schema de pagos necesita el uuid del padre. Si eso se hace bien, el `__pending_parent__` no vuelve.

---

## 5. Próximos pasos
1. **Lucas:** validar criterios 2-5 en `localhost:5174/pos/_spike-offline` (logueado) + decidir si crea instancia PowerSync para comparar.
2. Con eso, cerrar el motor (RxDB vs PowerSync) y este informe pasa de preliminar a final.
3. **Fase 1** (su propia spec→plan): migrar el flujo central al motor elegido, con el push **vía RPCs** + la migración `venta_idempotency_uuid` en pagos.
