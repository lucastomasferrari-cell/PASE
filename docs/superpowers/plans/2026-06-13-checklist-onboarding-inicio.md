# Checklist de bienvenida en el Inicio (Tier 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, tarea por tarea.

**Goal:** Tier 3 (informe 14-ux-settings-onboarding). Hoy existe un wizard `/onboarding` (5 pasos, tabla `tenant_onboarding_progress`, RPC `fn_onboarding_completar_paso`) pero vive en una página aparte que nadie ve (no hay redirect, es voluntario) y se marca 100% a mano. El informe 14 recomienda: **checklist persistente en el Home (Inicio), auto-completable** (se marca solo cuando el dueño hace la acción real), dismissable, ordenado por valor, métrica "primera venta <24h". Implementamos eso REUSANDO la infra existente: (1) una RPC que **auto-detecta** los pasos hechos mirando datos reales y los marca, (2) un **widget de checklist en el dashboard Inicio** que muestra el progreso.

**Alcance acotado:** Mantenemos los **5 pasos existentes** del modelo (`datos_local`, `primer_empleado`, `primer_insumo`, `primer_item`, `primer_canal`) — ya están en la tabla + el wizard. NO los re-ordeno/re-etiqueto (el informe sugería "venta de prueba" etc., pero eso no mapea a una columna y agrega complejidad — refinamiento futuro). El valor de este sprint es la **auto-detección + surface en el Home**, no rediseñar los pasos.

**Hechos verificados (recon 13-jun):** `tenant_onboarding_progress(tenant_id PK, paso_datos_local/primer_empleado/primer_insumo/primer_item/primer_canal BOOL + _at, completado BOOL + _at, asistido_por_email, RLS dual tenant)`; `fn_onboarding_completar_paso(p_paso TEXT)` SECURITY DEFINER idempotente (INSERT-if-missing + UPDATE flag); lectura via `getOnboardingProgress(tenantId)` en `lib/onboardingProgress.ts` (+ `calcularAvance`, `marcarPasoOnboarding`); wizard en `Onboarding.tsx` ruteado en App.tsx. Inicio = `dashboards/DashboardHome.tsx` (grid 12-col, widgets desde `registry.tsx` + `DEFAULT_WIDGETS_POR_ROL`, filtrados por permisos; ya existe `proximo_paso` widget). Auto-detección NO existe hoy (todo manual). Detección por paso: datos_local→`locales` con provincia/localidad NOT NULL; primer_empleado→`rrhh_empleados` activo count>0; primer_insumo→`insumos` count>0; primer_item→`items` count>0; primer_canal→`canales` count>0. Backfill 202605270100 dejó tenants viejos en completado=TRUE; tenant nuevo arranca en FALSE (o sin fila → tratar como todo-false).

**Reglas:** C7 (RPC nueva con auth check + REVOKE FROM PUBLIC,anon), dry-run, lint/typecheck, e2e/mutante, push + deploy READY. Bajo riesgo (Home widget + RPC read-only-ish que solo marca progreso, NO toca plata).

---

### Task 1: Migración — RPC de auto-detección

**Files:** Create `packages/pase/supabase/migrations/202606131000_onboarding_autodetect.sql`

- [ ] **Step 0:** Verificar columnas reales: `locales` tiene `provincia`/`localidad`? (grep migraciones locales). `insumos`/`items`/`canales`/`rrhh_empleados` tienen `tenant_id` + `deleted_at`/`activo`. Confirmar la firma de `fn_onboarding_completar_paso` y que hace INSERT-if-missing.
- [ ] **Step 1:** Escribir `fn_onboarding_autodetectar()` SECURITY DEFINER SET search_path=public:
  - Deriva `v_tenant := auth_tenant_id()`; si NULL → return (sin auth, no hace nada).
  - INSERT-if-missing la fila de `tenant_onboarding_progress` para el tenant (igual que la RPC de marcar — o reusar la lógica).
  - Para cada paso, si el flag está FALSE pero el dato real existe, marcarlo TRUE + timestamp:
    - `paso_datos_local`: EXISTS local del tenant con provincia o localidad no nula.
    - `paso_primer_empleado`: EXISTS rrhh_empleados activo (deleted_at IS NULL) del tenant.
    - `paso_primer_insumo`: EXISTS insumos del tenant (deleted_at IS NULL).
    - `paso_primer_item`: EXISTS items del tenant (deleted_at IS NULL).
    - `paso_primer_canal`: EXISTS canales del tenant.
  - NO marca `completado` automático (eso es decisión explícita del dueño — botón).
  - Devuelve la fila actualizada (RETURNS la tabla o jsonb con los flags) para que el front la use sin un segundo round-trip.
  - REVOKE ALL FROM PUBLIC, anon + GRANT authenticated.
  - Idempotente (solo marca lo que está FALSE y tiene dato; no desmarca nunca).
- [ ] **Step 2:** Commit `feat(onboarding): fn_onboarding_autodetectar marca pasos por datos reales (Tier3)`.

---

### Task 2: Aplicar en prod (dry-run) + verificación

- [ ] env pull → script Write tool → DRY_RUN=1 (ROLLBACK) → aplicar.
- [ ] Verificación: ejecutar `SELECT fn_onboarding_autodetectar()` en el contexto de un tenant con datos (vía un usuario real no se puede desde el script pg sin auth.uid — alternativa: probar la lógica con un SELECT manual que replique los EXISTS para Neko y confirmar que daría todo TRUE). Documentar. Limpiar temporales.

---

### Task 3: Widget de checklist en Inicio

**Files:**
- Create: `packages/pase/src/dashboards/widgets/OnboardingChecklistWidget.tsx`
- Modify: `packages/pase/src/dashboards/registry.tsx` (registrar), `DEFAULT_WIDGETS_POR_ROL` (agregar a dueno + admin)
- Maybe: `packages/pase/src/lib/onboardingProgress.ts` (agregar wrapper `autodetectarOnboarding()` que llama la RPC)

- [ ] **Step 1:** Leer `Onboarding.tsx` (para reusar labels/descripciones/CTAs de los 5 pasos), `lib/onboardingProgress.ts` (getOnboardingProgress, calcularAvance, marcarPasoOnboarding), `dashboards/widgets/ProximoPasoWidget.tsx` (patrón de widget + barra de progreso) y `registry.tsx` (cómo registrar + WidgetContext).
- [ ] **Step 2:** `OnboardingChecklistWidget`:
  - Al montar: llama `fn_onboarding_autodetectar()` (marca lo que ya esté hecho) y usa el resultado como estado.
  - Si `completado=TRUE` O los 5 pasos TRUE → no renderizar nada (return null) — no molestar a un tenant ya configurado (Neko, etc.). Esto evita que aparezca en tenants viejos (que están backfilled completos).
  - Si hay pasos pendientes: barra de progreso "X de 5" + lista de pasos. Cada paso: ✓ si hecho (opacidad baja), o número + título + descripción (beneficio) + botón "Abrir" (link a `/negocio`, `/equipo`, o deep-link COMANDA para insumo/item/canal) + "Ya lo hice" (marca manual vía `marcarPasoOnboarding`).
  - Botón "Listo, no mostrar más" → `marcarPasoOnboarding('completado')` (solo dueño/admin; encargado no ve ese botón).
  - Estilo: copiar el patrón de ProximoPasoWidget (CSS vars pase, sin inventar componentes).
- [ ] **Step 3:** Registrar en `registry.tsx` con `permisosRequeridos: []` (o el gate de dueño/admin si el registry lo soporta) y size "md". Agregar `'onboarding_checklist'` al principio de `DEFAULT_WIDGETS_POR_ROL.dueno` y `.admin` (NO a cajero/encargado/mozo — es setup del dueño).
- [ ] **Step 4:** `pnpm --filter pase typecheck && lint` verdes. Commit `feat(inicio): widget checklist de bienvenida auto-detectable (Tier3)`.

---

### Task 4: Tests

- [ ] **Mutante** `onboarding_autodetect_mutante.spec.ts` (DB-only contra prod, tenant E2E): el tenant E2E está backfilled completado, así que crear un tenant temporal NO (heavy). Alternativa: el mutante prueba la RPC sobre un estado controlado — como no podemos resetear el tenant E2E fácil, el test puede: leer el estado actual, verificar que `fn_onboarding_autodetectar()` es idempotente (correrla 2 veces da lo mismo) y que NO desmarca pasos ya TRUE. Para probar el "marca por dato real": crear un empleado de test en un tenant donde `paso_primer_empleado` esté FALSE — difícil con el E2E completado. **Criterio pragmático:** test de idempotencia + que no rompe + que para Neko/E2E (con datos) deja todos los pasos detectables en TRUE. Documentar la limitación de no poder testear "FALSE→TRUE" sin un tenant fresco.
- [ ] Alternativa mejor si encaja: un unit test del widget (vitest) que mockea getOnboardingProgress y verifica: completado → null; pasos pendientes → render con N pendientes; click "ya lo hice" → llama marcarPasoOnboarding.
- [ ] e2e-full COMPLETA verde (el widget no debería romper nada; el tenant E2E está completado → widget no renderiza).
- [ ] Commit tests.

---

### Task 5: Cierre

- [ ] Push + deploy pase READY.
- [ ] Smoke a Lucas: en un tenant nuevo/incompleto, el Inicio muestra el checklist; a medida que cargás empleado/insumo/item se auto-marca. En Neko (completo) no aparece.
- [ ] Memoria: checklist en Inicio con auto-detección; reusa tenant_onboarding_progress; pendiente refinamiento futuro (re-ordenar pasos por valor estilo informe 14 + paso "venta de prueba"); + plantilla por tipo de negocio y MESA módulo 2 siguen pendientes.

---

## Self-review
- Reusa toda la infra (tabla, RPC marcar, lib, registry) → bajo riesgo, poco código nuevo.
- El valor nuevo = auto-detección (informe 14) + surface en Home.
- Riesgo: el widget aparece en el dashboard de dueño/admin — si rompe el render del Home sería visible. Mitigado: return null cuando completado (tenants viejos no lo ven), typecheck/lint, e2e-full.
- No toca plata, no toca auth/permisos core.
- Decisión acotada: mantengo los 5 pasos existentes (no re-diseño) — el re-orden por valor del informe 14 queda como refinamiento futuro documentado.
