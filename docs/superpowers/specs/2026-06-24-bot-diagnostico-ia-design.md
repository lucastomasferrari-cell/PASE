# Bot de diagnóstico IA — asistente que entiende el sistema y mira la base

**Fecha:** 2026-06-24
**Estado:** Diseño — decisiones clave aprobadas (Lucas), pendiente de plan de implementación
**Área:** `packages/pase/api/claude.js` + nuevos helpers `api/_diagnostico-*.js`; `SoporteWidget.tsx` (COMANDA y PASE); permisos en `src/lib/auth.ts` + `Usuarios.tsx`. Lectura sobre datos de plata — **read-only estricto**.

## Problema

El bot de soporte de hoy (`SoporteWidget` → `/api/claude` task `soporte-chat`, Sonnet 4.6) **solo lee un manual fijo**. No puede mirar los datos reales, así que ante "hice un gasto y no lo encuentro", "esto no me cuadra", "no le figura el aguinaldo", solo puede dar consejos genéricos o sugerir abrir ticket. Lucas quiere que el asistente:

1. Resuelva dudas de funcionamiento **y** ayude con incógnitas, problemas, errores y fallas.
2. Entienda el sistema de punta a punta.
3. Pueda **ver información de la base de datos** para diagnosticar.
4. Tenga un **protocolo de preguntas** para ser preciso: que no barra toda la base, sino que junte los datos mínimos (local, fecha aprox, monto) y consulte lo justo.

## Decisiones tomadas (Lucas, 24-jun)

1. **Acceso por permiso**: se crea un permiso nuevo grantable desde Usuarios (Equipo → editar usuario), igual que `rrhh_liquidacion_final`. Quien lo tiene puede usar el modo diagnóstico; siempre **acotado a su tenant y a sus locales** (un encargado con el permiso solo diagnostica los suyos).
2. **Read-only (v1)**: el bot solo mira y explica. NO ejecuta acciones ni toca datos. (Acciones con confirmación = posible v2, fuera de alcance.)
3. **Alcance PASE + COMANDA**: cubre los dos. Gastos / conciliación / EERR / RRHH viven en PASE; COMANDA aporta ventas y caja del POS. El widget ya está en ambas apps.

## La idea central: menú cerrado de consultas (tool use), no acceso libre

El bot **no** escribe consultas libres a la base (riesgo de leak entre locales/tenants, dumps caros, exfiltración por prompt-injection). En su lugar tiene un **menú cerrado de "herramientas"**: un puñado de consultas prearmadas, parametrizadas, de **solo lectura**. Claude elige cuál usar según el caso y le pasa los parámetros; el servidor la corre **acotada y scopeada** y le devuelve solo lo justo. Es el patrón estándar de *tool use* (function calling).

El conocimiento "punta a punta" vive en: (a) el manual operativo que ya existe (`_soporte-prompt.js`), ampliado; (b) las herramientas, que encapsulan dónde está cada dato — el bot no necesita saber SQL ni el esquema crudo.

## Arquitectura

```
SoporteWidget (modo diagnóstico)
      │  task: 'diagnostico-chat'
      ▼
/api/claude  ──►  loop de tool use (server-side):
      │             1. arma system prompt (protocolo + manual) + define tools
      │             2. llama a Anthropic (Sonnet 4.6)
      │             3. si stop_reason = tool_use → ejecuta la consulta
      │                via _diagnostico-tools.js (read-only, scopeada)
      │             4. devuelve tool_result → vuelve a 2
      │             5. corta en end_turn o al cap de iteraciones (~5)
      ▼
respuesta final al usuario
```

- **Nuevo `task: 'diagnostico-chat'`** en `claude.js` (no es un endpoint nuevo: `claude.js` ya es una function; sumar una rama no toca el límite de 12 functions de Vercel).
- **Loop agéntico server-side** dentro del handler. Hoy `soporte-chat` es de un solo tiro; el diagnóstico necesita el loop tool_use → tool_result. Cap de iteraciones (~5) para no colgarse ni gastar de más.
- **Helper nuevo `_diagnostico-tools.js`**: las definiciones de tools (schema JSON) + la implementación de cada consulta. Usa el cliente `service_role` (como el resto de `api/`) y **filtra manualmente** por tenant + locales (regla E de CLAUDE.md: service_key bypassa RLS).
- **Helper `_diagnostico-scope.js`** (o función en el anterior): dado `auth.row` (id, rol, tenant_id), calcula los `local_id` visibles — dueño/admin/superadmin → todos los del tenant; encargado/cajero → `usuario_locales`. Toda tool filtra `tenant_id = X AND local_id = ANY(visibles)`.
- **Modelo**: Sonnet 4.6 (decisión de Lucas). Con caching de system prompt + tools, las vueltas del loop caen dentro de la ventana de 5 min → baratas (cache read 0,1×).

## El protocolo de preguntas

Sale de dos lugares que se refuerzan:

1. **Parámetros obligatorios en cada tool**: como el bot no puede consultar sin `local` / `fecha` / `monto≈`, *está forzado a preguntártelos antes de buscar*.
2. **Protocolo explícito en el system prompt**:
   - **Paso 1 — Clasificar**: ¿duda de uso? ¿algo que no aparece? ¿un número que no cuadra? ¿una falla técnica?
   - **Paso 2 — Juntar el mínimo** (1-2 preguntas, no interrogatorio): el local, una fecha aproximada, un monto aproximado, con qué cuenta.
   - **Paso 3 — Consultar lo justo**: una sola herramienta, rango chico. Nunca un barrido. Si hay varias candidatas, las muestra y pregunta cuál.
   - **Paso 4 — Interpretar y responder** corto, en rioplatense, y si corresponde sugerir el arreglo **por la UI** (no ejecuta).

Ejemplo: "hice un gasto de ~$50.000 y no lo encuentro" → pregunta local + fecha aprox + cuenta → `buscar_movimiento(local, tipo=gasto, fecha≈, monto≈50000)` → encuentra 1 fila → "lo cargaste con fecha 20/07 (futura): por eso el filtro lo escondía".

## Catálogo de herramientas v1

Todas **read-only**, scopeadas a tenant + locales visibles, con tope de filas (ej. 20). Muchas reutilizan lógica existente.

| Herramienta | Parámetros (req. en negrita) | Devuelve | Reutiliza |
|---|---|---|---|
| `buscar_movimiento` | **tipo** (gasto/ingreso/venta/pago/factura), **local**, fecha_desde, fecha_hasta, monto_aprox, cuenta, texto | Lista corta de coincidencias con id, fecha, monto, estado | query directa scopeada |
| `detalle_registro` | **tipo**, **id** | Detalle completo de un registro puntual (incluye anulado, fecha de carga vs fecha del hecho) | query directa |
| `estado_conciliacion_mp` | **local**, **mes** | Matched / falta justificar / diferencias del mes | lógica de Conciliación MP |
| `saldo_y_movimientos_cuenta` | **local**, **cuenta**, fecha | Saldo actual + últimos movimientos de la cuenta | `saldos_caja` + `movimientos` |
| `desglose_eerr` | **local**, **mes**, categoria | Total por categoría y las líneas que lo componen | EERR drill-down (`eerrDetalle`) |
| `estado_empleado` | **empleado** (o búsqueda por nombre), **local** | Liquidaciones, adelantos, aguinaldo, pagos del semestre | RRHH |
| `actividad_reciente` | **local**, fecha, usuario, tipo | Qué se cargó / editó / anuló recién | `movimientos`/`gastos`/auditoría |
| `fallas_recientes` | **local**, usuario | Últimos `console_errors` / tickets del usuario | `tickets_soporte.contexto_jsonb` |

(El set v1 se puede recortar/ampliar; arranca cubriendo los casos que nombró Lucas.)

## Seguridad y aislamiento

- **service_key + filtrado manual**: cada tool incluye `tenant_id = auth.row.tenant_id` y `local_id = ANY(locales_visibles)`. Sin esto habría leak (service_key no respeta RLS).
- **Solo lectura**: las tools solo hacen SELECT. Cero INSERT/UPDATE/DELETE. No hay tool que mueva plata.
- **Sin SQL libre**: el modelo nunca arma SQL; solo elige tool + parámetros validados server-side.
- **Tope de filas y de iteraciones**: cada tool limita filas; el loop limita vueltas (~5). Evita dumps y cost-runaway.
- **Rate limit**: ya existe (30 llamadas / 5 min / usuario en `claude.js`).

## Permisos

- Nuevo `PERMISO_EXTRA` en `src/lib/auth.ts`: `{ slug:"diagnostico_ia", label:"Asistente de diagnóstico IA", descripcion:"Permite usar el bot en modo diagnóstico (mira la base — solo lectura — para ayudar a encontrar y entender datos). Acotado a sus locales." }`. Aparece como checkbox en `Usuarios.tsx`. Dueño/admin/superadmin lo tienen por short-circuit.
- **Gate server-side**: `claude.js`, para `task: 'diagnostico-chat'`, verifica el permiso antes de habilitar las tools. Como la API usa `service_key` (no el JWT del user), se **replica** la lógica de `auth_tiene_permiso`: rol alto → sí; si no, la unión de `rol_permisos(rol_id)` + `usuario_permisos(usuario_id)` contiene `diagnostico_ia`. Sin permiso → cae al `soporte-chat` normal (solo manual) o 403, a definir.
- **Frontend**: `SoporteWidget` detecta el permiso (ya está en el user cacheado) y, si lo tiene, manda `task: 'diagnostico-chat'` y muestra que está en "modo diagnóstico". Sin permiso → comportamiento actual.

## Modelo, costo y tracking

- **Sonnet 4.6** ($3 in / $15 out por 1M). El loop multi-turn agrega vueltas, pero los resultados de las tools son chicos (filas puntuales) y el system prompt + tools van cacheados → cada vuelta extra es barata.
- **Estimación**: ~US$0,03–0,05 por conversación de diagnóstico → unos pocos dólares al mes con uso normal.
- **Fix de tracking (de paso)**: hoy `trackUsage` en `claude.js` solo guarda `input_tokens` e ignora los tokens cacheados (`cache_creation_input_tokens` / `cache_read_input_tokens`), por lo que `llm_usage_log.cost_usd` **subestima** la factura real (medido el 24-jun: registra ~US$0,0015/llamada cuando la real es ~US$0,018). Sumar esos campos al tracking y al `calcCost` (write 1,25× / read 0,1×) para que el costo registrado sea el real.

## Riesgos técnicos

- **Timeout de Vercel**: el loop multi-turn debe cerrar dentro del límite de la function. Mitigación: cap de iteraciones (~5), tools rápidas (queries acotadas con índices), y subir el `maxDuration` de la function si hace falta (config, no suma functions).
- **Latencia**: una conversación de diagnóstico puede tardar más que el chat de hoy (varias vueltas). Aceptable para diagnóstico; mostrar "pensando / buscando…" en la UI.
- **Precisión del scoping**: el cálculo de locales visibles server-side es el punto crítico de seguridad — necesita su propio test (un encargado NO debe poder diagnosticar otro local).

## Fuera de alcance (v1)

- **Ejecutar acciones** (corregir una fecha, anular, etc.): v2, con confirmación explícita y diseño por acción (es plata/datos).
- **Análisis de imágenes** en diagnóstico (eso ya lo cubre el flujo de tickets con screenshot).
- **Conexión a datos de otro tenant**: nunca.

## Próximos pasos

1. Escribir el **plan de implementación** (tareas TDD chiquitas) con la skill writing-plans, en orden de menor a mayor riesgo:
   - (a) Permiso + gate server-side + test de aislamiento.
   - (b) Loop de tool use en `claude.js` con 1 tool simple (`buscar_movimiento`) end-to-end.
   - (c) Resto del catálogo de tools.
   - (d) System prompt del protocolo de preguntas.
   - (e) UI del modo diagnóstico en `SoporteWidget`.
   - (f) Fix del tracking de caché.
2. Cada pieza con verificación; el scoping y cualquier lectura de plata, con test que pruebe el aislamiento.
