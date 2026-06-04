# RRHH — Planilla de sueldos base + aumentos masivos

**Fecha:** 2026-06-04
**Autor:** Lucas (dirigiendo) + Claude
**Estado:** Diseño aprobado en chat. Pendiente review del spec + plan de implementación.

## Problema
Hoy para cambiar el sueldo de un empleado hay que entrar a su Legajo, uno por uno.
Lucas quiere una **planilla tipo Excel** con todos los empleados y sus sueldos, editable
de una, + **aumentos masivos por % o por monto fijo** a todos o a los seleccionados.

## Lo que YA existe (no se reescribe)
- RPC `cambiar_sueldo_empleado(p_emp_id, p_nuevo_sueldo, p_motivo, p_idempotency_key)`:
  INSERT en `rrhh_historial_sueldos` + UPDATE `rrhh_empleados.sueldo_mensual`, atómico,
  SECURITY DEFINER, auth `dueno/admin OR auth_tiene_permiso('rrhh')`, no-op si igual.
- Tabla `rrhh_historial_sueldos` (historial de cambios). El legajo ya lo muestra.
- `sueldo_mensual` es la base única; mensual/quincenal/semanal derivan de ella → **un solo
  número por empleado**.

## Decisiones (Lucas, 04-jun)
- Aumento masivo: **por % Y por monto fijo**.
- Redondeo de resultados: **a $100** (con toggle para "sin redondeo" en casos puntuales).
- Ubicación: **pestaña nueva en RRHH** ("Sueldos base").
- Permiso: cualquiera con **`rrhh`** habilitado (igual que el resto de RRHH / la RPC actual).

## Arquitectura

### Frontend — `packages/pase/src/pages/rrhh/TabSueldosBase.tsx` (nuevo)
Pestaña dentro de RRHH (RRHH.tsx ya es lazy; la tab se renderiza adentro, sin tocar App.tsx).

- **Carga**: empleados activos del local (`applyLocalScope` sobre `rrhh_empleados`). Dueño puede
  ver/filtrar por local; encargado ve su local. Dedupe por `id` (empleados multi-local).
- **Planilla**: 1 fila por empleado:
  `[ ] · Apellido, Nombre · puesto · modo (Mensual/Quincenal) · Sueldo actual (read-only) · Sueldo nuevo (input editable)`.
  - State local `nuevos: Record<empId, number>` inicializado = sueldo actual.
  - Checkbox por fila + "seleccionar todos".
- **Barra de aumento masivo**:
  - Tipo: **%** | **monto fijo $**. Input valor. Toggle redondeo (default **$100**).
  - Botón "Aplicar a seleccionados (M)" / si no hay tildados "Aplicar a todos (N)".
  - Cálculo: `pct → actual*(1+v/100)`; `fijo → actual + v`. Redondeo a $100 = `Math.round(x/100)*100`.
    Cae en la columna "Sueldo nuevo" como **preview**. Se puede retocar fila por fila después.
- **Footer**: masa salarial **actual** (Σ sueldo actual) → **nueva** (Σ sueldo nuevo) + diferencia +
  cantidad de empleados con cambio.
- **Aplicar**: botón "Revisar y aplicar" → modal resumen (lista antes→después de los que cambian,
  totales, input **motivo** ej. "Aumento marzo 2026") → confirma → llama la RPC masiva.
  Post-éxito: recargar + toast.

### Backend — RPC nueva `cambiar_sueldos_masivo` (migración nueva)
```
cambiar_sueldos_masivo(p_cambios jsonb, p_motivo text, p_idempotency_key text DEFAULT NULL)
  -- p_cambios = [{ "emp_id": int, "nuevo_sueldo": numeric }, ...]
```
- Auth (C11): `auth_es_dueno_o_admin() OR auth_tiene_permiso('rrhh')` + tenant.
- Idempotency (C1): tabla `idempotency_keys`.
- Loop sobre p_cambios EN UNA TRANSACCIÓN (todo o nada):
  - lock empleado (`FOR UPDATE`), validar tenant + `nuevo_sueldo > 0`, skip no-op,
    INSERT `rrhh_historial_sueldos` + UPDATE `rrhh_empleados.sueldo_mensual`. Mismo motivo para todos.
- Retorna `{ ok, cambiados: N, total_anterior, total_nuevo }`.
- Errores UPPER_SNAKE (C9): `MONTO_INVALIDO`, `EMPLEADO_NO_ENCONTRADO`, `NO_AUTORIZADO`, `SIN_CAMBIOS`.

### Helper de cálculo — `src/lib/calculos/rrhh.ts`
- `aplicarAumento(actual, { tipo: 'pct'|'fijo', valor, redondeo: 100|null }): number`
  (testeable unitariamente).

## Cumplimiento reglas Capa 1
- C1 idempotency ✓ · C2 mutante ✓ · C3 applyLocalScope sobre rrhh_empleados ✓ ·
- C4 escritura a rrhh_* solo vía RPC ✓ · C8 (no toca App.tsx, RRHH ya lazy) ✓ ·
- C9 error codes mapeados en `errors.ts` ✓ · C11 auth en RPC ✓.

## Edge cases
- Sueldo actual 0/null: `% → 0`, `fijo → suma`. No rompe.
- Resultado ≤ 0 (monto fijo negativo grande): la RPC valida `nuevo_sueldo > 0` y rechaza; el
  front avisa antes.
- Quincenal/semanal: se edita `sueldo_mensual` (la base) — correcto.
- Multi-local: sueldo es global al empleado; dedupe por id en la vista.

## Tests
1. **Unit** (`rrhh.test.ts`): `aplicarAumento` (% , fijo, redondeo $100, sin redondeo, base 0).
2. **Mutante** (`sueldos_masivo_mutante.spec.ts`): RPC sobre 2 empleados de prueba → ambos
   `sueldo_mensual` actualizados + 2 filas en `rrhh_historial_sueldos` + idempotency replay no
   duplica. Cleanup: revertir sueldos + borrar filas de historial.
3. **E2E full**: caso nuevo — aumento masivo sobre 2 empleados del seed, verifica sueldos +
   historial.

## Fuera de alcance (v1)
- Pantalla dedicada de "evolución de sueldos" (el historial ya se ve en el legajo).
- Aumentos programados a futuro / por convenio.
- Deshacer un aumento masivo en un click (se puede empleado por empleado desde el legajo).
