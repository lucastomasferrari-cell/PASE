# Spec — Rebuild offline-first de COMANDA ("como Toast") · Arquitectura objetivo + Fase 0 (Spike)

**Fecha:** 2026-06-18
**Autor:** Lucas + Claude
**Estado:** Diseño para revisión

> Nace de que el offline-first actual resultó net-negativo en uso real (lag por UI no-optimista + cola trabada `__pending_parent__` + crash al anular por chunk lazy) y se APAGÓ por default el 18-jun (commit `ca9a957`). Análisis completo en `project_comanda_offline_decision_18_jun.md`. **Directiva de Lucas: hacerlo "como Toast", rehaciendo lo que haga falta — sin parchar la base frágil.** Aplica su preferencia conocida por la solución arquitectónica de largo plazo (no la pragmática).

> **Este spec es de un proyecto grande, por eso está decomponido en fases.** El cuerpo detalla la **arquitectura objetivo** + la **Fase 0 (Spike)**, que es la única que se va a planear/construir a continuación. Las Fases 1-3 quedan sketcheadas como roadmap; cada una tendrá su propia spec→plan cuando llegue su turno.

---

## 1. Objetivo

Que COMANDA (web POS) se comporte **como Toast**: la terminal sigue funcionando sola cuando se corta internet (tomar pedidos, cobrar), instantánea siempre, y sincroniza con la nube en segundo plano cuando vuelve — todo automático, sin botón, sobreviviendo a recargar la tablet. Reemplazar la capa de sync artesanal actual (~3.840 LOC frágiles) por un **motor local-first probado**.

**Principio rector (no negociable):** *la red NUNCA está en el camino de un toque.* El toque escribe local y pinta al instante; la subida pasa después, invisible.

---

## 2. Decisiones tomadas (brainstorm 18-jun)

- **Motor local-first ya hecho** (no más cola hand-rolled). El motor da: copia local en la tablet (SQLite), sync bidireccional con Supabase, cola/reintentos/reconciliación probados.
- **Recomendación de motor: PowerSync** (integración oficial Supabase, RLS-aware, server-authoritative, hecho para offline-first). **Alternativa gratis: RxDB.** La elección final se **valida en la Fase 0** (spike), no antes.
- **Rebuild, no parche:** el sistema offline actual se reemplaza y se borra; no se construye encima.
- **Modelo Toast:** la terminal es la fuente de verdad **del momento**; Supabase es la verdad **final**. Offline, cada terminal es una isla (NO hay sync en tiempo real entre terminales durante el corte) — se reconcilian al reconectar. Esto simplifica los conflictos.
- **Conflictos:** server-authoritative + last-write-wins por entidad/campo. Sin CRDTs (overkill a esta escala: pocas terminales, rara vez tocan la misma mesa al mismo segundo).
- **PWA:** la app se precachea entera en la tablet para cargar sin internet y sobrevivir recargas (mata la clase de bug del chunk dinámico).
- **Todo detrás del flag `offlineFirstVentas` (hoy apagado):** cero impacto en producción hasta que esté sólido y se prenda.

---

## 3. Arquitectura objetivo

Cuatro piezas:

1. **Motor + copia local (SQLite en la tablet).** La app lee/escribe contra el store local. El motor mantiene ese store sincronizado con Supabase (descarga el estado relevante del local, sube los cambios). Maneja la cola de subida, reintentos, idempotencia y reconciliación — todo de la librería, no nuestro.
2. **UI optimista por construcción.** Como la UI lee/escribe del store local, cada acción es instantánea (online u offline). Se elimina el `await` de red en el camino del toque y el `reload()` por cambio.
3. **PWA (app shell offline).** Service worker que precachea la app completa → carga sin internet + sobrevive recargar. Reemplaza la config actual (NetworkFirst + chunks lazy no precacheados) que causaba el "Failed to fetch dynamically imported module".
4. **Supabase = verdad final.** Sigue siendo el backend; las RPCs atómicas existentes son el destino del sync. Los wrappers `_offline` artesanales y la cola actual se retiran.

**Flujo de un toque (objetivo):** tap → escribe en SQLite local (microsegundos) → la pantalla pinta del local → el motor sube a Supabase en background, invisible. Sin internet: igual, y la subida queda encolada por el motor hasta que vuelve.

---

## 4. Por qué un motor y no seguir hand-rolled

El análisis (2 agentes) dictaminó que la capa actual es frágil y sprawling: flag prendido/apagado 4 veces, bug vivo que pierde cobros/anulaciones (`__pending_parent__` sin `depends_on`), cola que se traba, y una acción de plata (anular) que depende de bajar un chunk por red. Construir Toast-grade a mano es exactamente lo que falló. Un motor probado (PowerSync/RxDB) resuelve el store local + sync + reconciliación + idempotencia como librería battle-tested. Es la decisión arquitectónica de largo plazo que pidió Lucas.

---

## 5. Fase 0 — Spike (el foco de este spec)

**Por qué primero:** un rebuild de la capa de datos es caro; elegir mal el motor es el error caro. El spike valida motor + patrón con UN flujo real antes de comprometer la migración entera.

**Objetivo:** tener UN circuito completo —**abrir mesa → agregar ítem → cobrar**— funcionando end-to-end sobre el motor (PowerSync primero), y con eso decidir go/no-go del motor.

**Alcance (qué se construye):**
- Montar **PowerSync** contra la DB Supabase existente (tablas `ventas_pos`, `ventas_pos_items`, `ventas_pos_pagos`, `mesas`/`items` lo mínimo para el flujo), con su sync rules + auth (Supabase JWT/RLS).
- Un **módulo/ruta de spike AISLADO** (ej. `/pos/_spike-offline`, no linkeado en el nav, gateado a dev/superadmin) que implemente el flujo abrir→agregar→cobrar **leyendo/escribiendo del store local del motor** — SIN tocar los `services/` ni `offline/` actuales.
- Correr contra un **local/tenant de prueba** (Local Prueba 2 / tenant E2E), nunca data real.
- Un **comparativo rápido con RxDB** (al menos evaluar la integración Supabase + el modelo relacional vs documento) para confirmar o cambiar la recomendación.

**Qué se valida (criterios go/no-go):**
1. **Instantáneo:** el toque pinta sin esperar red (medible: < 100 ms percibido).
2. **Offline real:** con la red cortada (DevTools offline), el flujo completo funciona y **sobrevive recargar la página**.
3. **Reconciliación:** al volver la red, los cambios suben solos y el estado local ↔ Supabase queda consistente (sin duplicados — idempotencia del motor).
4. **RLS / multi-tenant:** el motor respeta los permisos por tenant/local (no leakea entre locales).
5. **DX / esfuerzo:** qué tan invasivo es migrar una pantalla real (estimar el costo de las Fases 1-2).
6. **Costo / operación:** plan free de PowerSync alcanza para 1 restaurante; qué hay que correr/pagar. (Si es prohibitivo → RxDB.)

**Fuera de alcance de la Fase 0:** migrar pantallas reales, endurecer la PWA, borrar el código viejo, cobrar tarjeta offline. Eso es Fase 1+.

**Entregable de la Fase 0:** (a) el flujo de spike andando, (b) un **informe corto de decisión**: motor elegido (PowerSync o RxDB) con evidencia de los 6 criterios, y (c) el **patrón validado** (cómo se lee/escribe/sincroniza una entidad) que las Fases 1-2 van a replicar. Si NINGÚN motor pasa los criterios, el spike lo dice y reconsideramos (incluido "hand-rolled bien hecho" como último recurso).

---

## 6. Fases siguientes (roadmap — cada una su spec→plan)

- **Fase 1 — Flujo central:** migrar ventas/mesas/ítems/cobro al motor con UI optimista, detrás del flag.
- **Fase 2 — Resto + PWA + limpieza:** overrides (anular/cortesía/precio/descuento), transferir/unir/partir mesa, mermas; arreglar/endurecer la PWA; **borrar** la capa offline vieja (`lib/sync/*`, `services/offline/*`, wrappers `_offline` SQL).
- **Fase 3 — Conmutación:** test mutante + e2e por flujo; smoke con Lucas; prender el flag; monitorear.

---

## 7. Riesgos / cosas a cuidar

- **DB compartida PASE+COMANDA:** el motor sincroniza solo tablas de COMANDA; cuidar no afectar PASE. Las sync rules deben acotar el dataset.
- **Costo PowerSync:** validarlo en Fase 0; RxDB es el plan B sin costo.
- **Tamaño del dataset local:** un local tiene catálogo + ventas del turno — chico, entra holgado en SQLite/IndexedDB.
- **Pagos con tarjeta offline:** NO en este alcance (riesgo financiero, igual que Toast lo trata aparte). Futuro.
- **Migración gradual:** mientras se migra flujo por flujo, conviven el camino viejo (apagado) y el nuevo (detrás del flag) — no mezclarlos en la misma pantalla.

---

## 8. Reglas del repo

- Todo detrás del flag `offlineFirstVentas` hasta conmutar.
- Cada flujo migrado: **test mutante + e2e** (regla C2 / e2e-full) antes de prender.
- RPCs/sync nuevas respetan auth/RLS; nada ejecutable por `anon`.
- Comunicación en español simple antes de cambios no triviales; push directo a main; verificar deploy READY de COMANDA.

---

## 9. Criterio de éxito

**Fase 0:** un flujo (abrir→agregar→cobrar) corre instantáneo, offline, sobrevive recarga y reconcilia sin duplicados sobre el motor elegido — con un informe que dice cuál motor y por qué.
**Proyecto:** el mozo, en pleno rush y con internet inestable, carga y cobra sin esperar ni un milisegundo a la red; si se corta, no se entera; cuando vuelve, todo subió solo. Como Toast.
