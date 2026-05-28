# VentaScreen split — design doc

**Estado:** Diseño aprobado, pending implementation (sprint #3 post-audit grande).
**Owner:** Lucas + Claude
**Fecha:** 2026-05-27 — diseño desde sesión "seguir sin parar" post-auditoría.

---

## Problema

`packages/comanda/src/pages/Pos/VentaScreen.tsx` es un god-object:
- **1378 LOC** — la pantalla más grande de COMANDA.
- **30 `useState` declarados** — superficie de cambios enorme.
- **15 `useCallback` / `async function`** mezcladas con render.
- **10 dialogs distintos** (`PaymentDialog`, `EmitirFacturaDialog`,
  `DiscountDialog`, `TransferMesaDialog`, `MergeMesasDialog`,
  `SplitCheckDialog`, `ManagerOverrideDialog`, `ModifiersDialog`,
  `AgotarDialog`, `Dialog` plano para anular).
- **3 services** distintos cruzados (`ventasService`, `overridesService`,
  `itemsService`) con queries directas a `db` por encima.
- Realtime `useRealtimeTable` + `listenReconcile` mezclados con UI logic.

Es el componente más crítico (mueve cobros + manda comandas a cocina + aplica
overrides de manager). Cualquier bug acá pierde plata o rompe el servicio
en vivo.

## Por qué no se rompió todavía

- Anto y Lucas testean en Neko de forma constante.
- El test E2E full cubre el flow básico (T15 marketplace pedido online).
- Lucas pidió `cada feature nueva = test mutante E2E` (regla 2026-05-09).

## Por qué SÍ hay que hacerlo

- **Mantenibilidad:** agregar una feature nueva (ej. propinas dividas) hoy
  requiere leer 1378 LOC y entender 30 states + 15 callbacks.
- **Performance:** todo el árbol re-rendea por cualquier mínimo state change.
  Componentes hijos no pueden memorizarse fácil porque dependen de muchísimos
  callbacks no-estables.
- **Testing:** unit tests sobre cualquier sub-logica son imposibles — la
  lógica vive dentro del componente.
- **Conflictos:** si dos developers tocan VentaScreen al mismo tiempo, merge
  conflicts garantizados.

---

## Split propuesto

Splitting en **3 hooks custom + 6 subcomponentes**. El archivo principal queda
como **orquestador (~250-300 LOC)** que ata todo.

### Hooks custom (lógica desacoplada de UI)

#### 1. `useVentaData(ventaId)`
Responsabilidad: carga + reload de los 4 datasets primarios.

**State retornado:**
- `venta: VentaPos | null`
- `items: VentaPosItem[]`
- `catalogo: ItemConGrupo[]`
- `grupos: ItemGrupo[]`
- `loading: boolean`

**Actions retornadas:**
- `reloadFull()` — recarga todo (load inicial)
- `reloadVenta()` — solo venta + items (post mutación)
- `setItems()` para merge incremental (opcional)

**Side effects:**
- `useEffect` para load inicial al mount
- `useEffect` para `useRealtimeTable('ventas')` y `useRealtimeTable('venta_items')`
  que disparan `reloadVenta()`
- `useEffect` para `listenReconcile()` que aplica replace de IDs locales

**Archivo:** `packages/comanda/src/pages/Pos/hooks/useVentaData.ts`

#### 2. `useVentaCursos(items, cursoActivo)`
Responsabilidad: derivar agrupaciones por curso.

**Pure derived state (useMemo):**
- `itemsPorCurso: Record<number, VentaPosItem[]>`
- `tiempoEstimadoMin: number` (basado en items pending por curso)
- `holdCount(curso)`, `stayCount(curso)` — helpers

**Sin side effects.** Es 100% derivado.

**Archivo:** `packages/comanda/src/pages/Pos/hooks/useVentaCursos.ts`

#### 3. `useVentaOverrides(ventaId)`
Responsabilidad: state + actions del flow de overrides manager (anular item,
cortesía, cambiar precio).

**State retornado:**
- `historial: VentaOverrideHistoria[]`
- `historialOpen: boolean`
- `anularItemTarget: VentaPosItem | null`
- `cortesiaItemTarget: VentaPosItem | null`
- `precioItemTarget: VentaPosItem | null`
- `precioNuevo: number`, `precioMotivo: string`
- `showPrecioMgr: boolean`

**Actions:**
- `openHistorial()`, `closeHistorial()`
- `requestAnular(item)`, `confirmAnular(managerToken)`
- `requestCortesia(item)`, `confirmCortesia(managerToken)`
- `requestPrecio(item)`, `confirmPrecio(managerToken)`
- `loadHistorial()` (refetch)

**Archivo:** `packages/comanda/src/pages/Pos/hooks/useVentaOverrides.ts`

---

### Subcomponentes UI

#### 1. `VentaHeader` (~80 LOC)
**Renders:**
- Botón back (`ArrowLeft`)
- Número ticket + badge estado (`EstadoVentaBadge`)
- DropdownMenu con: editar notas, transferir mesa, mergear mesas, split check,
  ver historial overrides, anular venta.

**Props:**
- `venta: VentaPos`
- `editable: boolean`
- Callbacks: `onBack`, `onEditNotas`, `onTransfer`, `onMerge`, `onSplit`,
  `onAnular`, `onOpenHistorial`

**Archivo:** `packages/comanda/src/pages/Pos/components/VentaHeader.tsx`

#### 2. `VentaCatalogoPanel` (~150 LOC)
**Renders:**
- Search input
- Grupos buttons (incluyendo "Favoritos")
- Grilla de items filtrada (incluye click-to-add y long-press para modifiers)

**Props:**
- `catalogo: ItemConGrupo[]`
- `grupos: ItemGrupo[]`
- `favoritosSet: Set<number>`
- `grupoSel`, `search`, `setGrupoSel`, `setSearch`
- `lastAddedItemId: number | null` (para flash visual)
- Callbacks: `onAddItem(item)`, `onLongPress(item)` (abre modifiers),
  `onToggleFav(item)`, `onAgotar(item)`

**Archivo:** `packages/comanda/src/pages/Pos/components/VentaCatalogoPanel.tsx`

#### 3. `VentaListaPanel` (~250 LOC)
**Renders:**
- Lista de items agrupados por curso (tabs visuales)
- Cada item: nombre, modificadores, notas, cantidad (Stepper), precio
- Iconos de acciones: anular, cortesía, cambiar precio (requieren mgr)
- Stay/hold toggle por item
- Flash visual en `lastAddedRowId`

**Props:**
- `itemsPorCurso`, `cursoActivo`, `setCursoActivo`
- `itemsConModifiers: Set<number>`
- `editable: boolean`
- Callbacks: `onModificarCantidad`, `onAnularItem`, `onCortesiaItem`,
  `onCambiarPrecio`, `onToggleStay`, `onMandarItemSolo`

**Archivo:** `packages/comanda/src/pages/Pos/components/VentaListaPanel.tsx`

#### 4. `VentaFooter` (~80 LOC)
**Renders:**
- Total + breakdown (subtotal, descuento, cubierto, propina)
- Botón "Mandar curso N" (con badge de items pending)
- Botón "Cobrar" (estado: cobrada disabled, parcial highlighted)
- Botón "Aplicar descuento" (opcional, según permiso)

**Props:**
- `venta`, `items`, `cursoActivo`, `tiempoEstimadoMin`
- Callbacks: `onMandarCurso`, `onCobrar`, `onDescuento`, `onFacturar`

**Archivo:** `packages/comanda/src/pages/Pos/components/VentaFooter.tsx`

#### 5. `VentaDialogs` (~200 LOC)
**Renders:** wrapper que renderiza todos los dialogs y dispatcha props.

**Props (mucha pero plana):**
- Estados de visibilidad (`showCobro`, `showEmitirFactura`, etc.)
- Targets (`pendingModifiers`, `anularItemTarget`, etc.)
- Setters de cierre + onSuccess de cada uno

**Archivo:** `packages/comanda/src/pages/Pos/components/VentaDialogs.tsx`

Alternativa: dejar los dialogs inline en VentaScreen — son simples wrappers
y agruparlos en otro archivo agrega indirección. Decisión a tomar en
implementación.

#### 6. `VentaScreen` (orquestador, ~300 LOC)
**Estructura final:**
```tsx
export function VentaScreen() {
  const { ventaId } = useParams();
  const data = useVentaData(ventaId);
  const cursos = useVentaCursos(data.items, cursoActivo);
  const overrides = useVentaOverrides(ventaId);

  if (data.loading) return <Loading />;
  if (!data.venta) return <NotFound />;

  return (
    <div>
      <VentaHeader venta={data.venta} {...handlers} />
      <div className="grid grid-cols-2">
        <VentaCatalogoPanel {...catalogoProps} />
        <VentaListaPanel
          itemsPorCurso={cursos.itemsPorCurso}
          {...overrides.actions}
          {...listaProps}
        />
      </div>
      <VentaFooter
        total={data.venta.total}
        tiempoEstimadoMin={cursos.tiempoEstimadoMin}
        {...footerProps}
      />
      <VentaDialogs {...dialogProps} />
    </div>
  );
}
```

---

## Estrategia de implementación

### Fase 1: Tests E2E mutantes (PRE-REQUISITO)
**Regla 2026-05-09:** no se toca código de plata sin test mutante.

VentaScreen no tiene test mutante propio. Antes del split, crear:
- `packages/comanda/tests/venta_screen_mutante.spec.ts`
- Cubre el flow completo: crear venta → agregar items → mandar curso →
  modificar item → aplicar descuento → cobrar → verificar movimientos.
- Mutaciones a verificar: que el split no rompa cobro, no rompa mandar curso,
  no rompa override de manager.

### Fase 2: Hooks (sin tocar UI)
1. Extract `useVentaData` con todos los reload functions.
2. Verificar typecheck + correr tests E2E full.
3. Extract `useVentaCursos`.
4. Extract `useVentaOverrides`.
5. VentaScreen ya queda ~900 LOC (con UI intacta).

### Fase 3: UI subcomponentes
6. Extract `VentaHeader` (más simple).
7. Extract `VentaFooter`.
8. Extract `VentaCatalogoPanel`.
9. Extract `VentaListaPanel` (el más grande, casi mitad).
10. Decisión `VentaDialogs`: extraer o dejar inline.
11. VentaScreen final ~300 LOC.

### Fase 4: Optimización
12. Memoizar handlers con `useCallback` estables.
13. `React.memo()` en los subcomponentes que no cambian frecuente
   (VentaCatalogoPanel, VentaFooter).
14. Verificar con React DevTools profiler que el render count bajó.

---

## Estimado

| Fase | Esfuerzo |
|------|----------|
| Fase 1 — tests E2E mutantes | 3-4h |
| Fase 2 — hooks | 2-3h |
| Fase 3 — subcomponentes UI | 4-6h |
| Fase 4 — optimización + verificación | 1-2h |
| **Total** | **10-15h** |

Sprint dedicado de 1 día completo (~8h enfocadas) + buffer si surgen bugs
durante extracts.

---

## Riesgos

1. **Realtime + reload races:** el split de `useRealtimeTable` adentro del hook
   puede causar dobles reload si el cleanup del useEffect no es estricto.
   Mitigación: tests E2E con mutaciones que verifiquen el state final.

2. **Stale closures en handlers:** mover callbacks afuera puede romper
   capturas de state. Mitigación: usar `useEvent` pattern donde haga falta
   o passing del state actual via prop.

3. **Modifiers + agregar item flow:** el flow long-press → ModifiersDialog →
   addItem(item, modificadores) es complejo. Mantenerlo intacto durante
   los extracts.

4. **Manager override TOTP:** override hooks dependen de state cross-flow
   (anular vs cortesía vs precio). El hook unificado los resuelve, pero hay
   que mantener compatibilidad con el `ManagerOverrideDialog` shared.

---

## No-goals

- **NO** introducir context o stores globales (Zustand, Redux). Props drilling
  está OK con 3-4 hop max.
- **NO** cambiar lógica de negocio. Si descubrimos un bug durante el split,
  documentarlo aparte y resolverlo en commit separado.
- **NO** mejorar UI/UX. Es puro refactor de estructura, mismo render output.

---

## Checklist al merge

- [ ] Tests E2E mutantes pasan (fase 1)
- [ ] Typecheck PASE + COMANDA ✅
- [ ] `pnpm --filter comanda test` ✅
- [ ] Suite E2E full corre verde (workflow GH Actions)
- [ ] Smoke test manual: crear venta en Neko, agregar 3 items, mandar curso,
      cobrar — todo OK.
- [ ] React DevTools profiler: render count del CatalogoPanel bajó vs antes.
- [ ] Memoria actualizada en `project_pase_features_27_may.md`.
