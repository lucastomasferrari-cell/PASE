# Diseño: Modelo multi-marca — "Grupo → Marca → Sucursal" (estilo Toast)

> Estado: **DISEÑO** (no implementado). Decidido 2026-06-30 con Lucas.
> Reemplaza la idea previa de "1 marca = 1 tenant" (descartada: rompía lo
> compartido entre marcas, que ya está implementado y se quiere mantener).

---

## 1. El modelo correcto (3 niveles, como Toast)

```
TENANT = EL GRUPO / DUEÑO        ← COMPARTIDO: empleados, proveedores, insumos, usuarios, recetas
   ├─ MARCA: Neko Sushi          ← PROPIO: menú + branding + reportes
   │    ├─ Local: Villa Crespo
   │    ├─ Local: Belgrano
   │    └─ Local: Devoto
   ├─ MARCA: Maneki Sushi & Asian
   │    └─ Local: (sucursal)
   └─ MARCA: Rene Cantina
        └─ Local: (sucursal)
```

**Principio:** se comparte ARRIBA, se separa ABAJO.
- **Tenant (grupo)** = frontera de lo compartido: empleados multi-marca, compras
  (proveedores/insumos), usuarios/admins transversales, recetas. **Ya funciona hoy.**
- **Marca** = capa nueva que agrupa locales y se lleva lo que debe diferir por
  concepto: **menú maestro, branding, y el filtro de reportes**.
- **Local (sucursal)** = pertenece a una marca.

### Por qué NO "1 marca = 1 tenant"
El tenant es la frontera dura de aislamiento. Separar marcas en tenants distintos
rompería: empleados que trabajan en varias marcas, proveedores/insumos compartidos,
y un admin/comprador que maneja todas las marcas. Todo eso ya está implementado a
nivel tenant. El modelo de grupo lo preserva.

### Cómo lo hace Toast (referencia)
Restaurant Group (cuenta del dueño) → Locations (cada local con su menú/branding).
Comparte empleados, usuarios y reporting a nivel grupo; separa menú/branding/números
por location. Soporta multi-concepto (varias marcas) bajo un grupo. Nuestro modelo
es igual, con un nivel "marca" explícito entre grupo y local (porque Neko tiene 3
sucursales que comparten un mismo menú/branding).

---

## 2. Estado actual

- Tenant único `neko` con todos los locales adentro: Villa Crespo, Belgrano, Devoto,
  Maneki, Rene Cantina (local 5), + prueba.
- **Ya compartido y funcionando** (mantener): empleados multi-marca, proveedores,
  insumos, recetas, usuarios.
- Reparto de locales por marca (definido por Lucas 2026-06-30):
  - **Neko** → Villa Crespo, Belgrano, Devoto
  - **Maneki** → su local
  - **Rene Cantina** → su local
- El menú de sushi cargado el 2026-06-29/30 quedó tenant-global (`local_id=NULL`).
  Hay que reasignarlo a la **marca Neko**.

---

## 3. Qué se construye

### Pieza A — Tabla `marcas` + `locales.marca_id`
```
marcas
  id            serial/uuid PK
  tenant_id     uuid NOT NULL REFERENCES tenants(id)
  nombre        text            -- "Neko Sushi", "Maneki", "Rene Cantina"
  slug          text
  logo_url      text            -- branding
  color_primary text            -- branding
  orden         int
  deleted_at    timestamptz
```
- `locales.marca_id` → FK a `marcas`. Cada local pertenece a una marca.
- Seed: crear las 3 marcas, taggear cada local.

### Pieza B — Menú por marca
Hoy los items son por tenant (`local_id NULL` = global) o por local. Cambiar a
**scope por marca**:
- Agregar `items.marca_id`, `item_grupos.marca_id`, `modifier_groups.marca_id`.
- El POS, al abrir venta en un local, resuelve el menú de la **marca de ese local**.
- Migración del menú actual: los 53 items sushi → `marca_id = Neko`.
- (Las listas de precios por canal siguen funcionando; el canal vive dentro de la
  marca.)

### Pieza C — Branding por marca
La UI lee logo/colores/nombre de la **marca activa** (según el local en el que se
está operando), no del tenant. Override por local = futuro.

### Pieza D — Reportes filtrables por marca
- Reportes con selector **Marca** (además del de local).
- "Reportes de Neko" = suma de sus 3 sucursales. "Reportes de Rene" = su local.
- Separados por marca (lo que pidió Lucas), con drill-down a local.

### Pieza E — Acceso de usuarios por marca/local (transversal)
- El sistema de "locales visibles por usuario" (`usuario_locales`) **ya permite**
  que un usuario vea locales de varias marcas (todas en el mismo tenant).
- Agregar UX para asignar acceso "por marca" (atajo = todos los locales de esa
  marca) además de por local suelto.
- Caso comprador/admin transversal: se le dan los locales de las 3 marcas → ve y
  maneja compras/insumos de todas. **Sin cruzar tenants.**

---

## 4. Flujo de venta del producto

- Cliente con **1 marca, 1+ locales** → 1 tenant, 1 marca, N locales.
- Cliente con **varias marcas** (este caso) → 1 tenant (grupo), N marcas, locales
  repartidos. Empleados/compras/usuarios compartidos; menú/branding/reportes por
  marca.
- Onboarding: extender el alta para crear tenant + 1 marca + 1 local; y permitir
  "agregar marca" a un grupo existente.

---

## 5. Plan por fases

| Fase | Qué | Riesgo |
|---|---|---|
| **0** | Confirmar reparto de locales por marca + inventario. | Bajo |
| **1** | Tabla `marcas` + `locales.marca_id` + seed (3 marcas, tag locales). | Bajo |
| **2** | Menú por marca: `marca_id` en items/grupos/modifiers + POS resuelve por marca + migrar menú actual a marca Neko. | Medio |
| **3** | Branding por marca (logo/colores leídos de la marca activa). | Bajo |
| **4** | Reportes con filtro de marca + drill-down a local. | Medio |
| **5** | UX de acceso por marca (asignar usuario a marca = todos sus locales). | Bajo |

**Nota:** no hay migración de datos entre tenants. Lo operacional (ventas, caja,
sueldos) NO se mueve — sigue colgando de su local; solo se agrega la dimensión
"marca" arriba del local. Riesgo mucho menor que el plan de tenants separados.

---

## 6. Decisiones (actualizadas 2026-06-30)

1. ✅ **Reparto de locales**: Neko = Villa Crespo + Belgrano + Devoto; Maneki = su
   local; Rene = su local.
2. ✅ **Compras/insumos/empleados compartidos**: SÍ, se mantienen a nivel tenant
   (ya implementado).
3. ✅ **Admin/comprador transversal**: soportado vía locales visibles (mismo tenant).
4. ⬜ **¿Maneki y Neko comparten platos de sushi?** Si sí: se cargan en cada marca
   por separado (el menú es por marca; no se comparte entre marcas). Confirmar si
   se quiere un mecanismo de "copiar menú de una marca a otra".
5. ⬜ **¿Recetas/insumos por marca o 100% compartidos?** Hoy compartidos (tenant).
   ¿Un insumo de Rene debe ser invisible para Neko, o da igual? (Define si las
   recetas necesitan también `marca_id` o quedan tenant-level.)

---

## 7. Regla de oro

PASE corre en prod sobre el tenant Neko. Este modelo **agrega** una capa (marca)
sin mover datos operacionales entre tenants → bajo riesgo. Igual: cada migración
en transacción, con verificación de que ningún local quede sin marca y que el menú
quede asignado a la marca correcta.

---

# 8. ANÁLISIS PROFUNDO DEL SISTEMA ACTUAL (2026-06-30)

Tres exploraciones del código real. Conclusión global: **el sistema YA está
preparado en un 70%**. El patrón `local_id NULL = global / N = específico` y la
relación m:n `usuario_locales` hacen casi todo el trabajo. La "marca" es una capa
que se **agrega encima**, no un rediseño.

## 8.1 Menú (items / grupos / modificadores) — qué hay y qué choca

**Hoy:**
- `items`, `item_grupos`, `modifier_groups` tienen `tenant_id` + `local_id`
  (NULL = global del tenant). Unique = `(tenant_id, COALESCE(local_id,0), LOWER(nombre))`.
- **El POS carga el catálogo SIN filtrar por local** (`listItems({ tenantId })` en
  `itemsService.ts`). Devuelve TODOS los items del tenant; la RLS recién filtra por
  `local_id`. → Hoy, como todo es `local_id NULL`, **todos los locales ven el mismo
  menú** (por eso el sushi apareció en todos).

**Choca con el modelo marca:** el menú tiene que colgar de la **marca**, no del
local ni del tenant entero. Hoy no hay forma de decir "este item es de Neko y no
de Rene".

**Cómo se modifica sin romper:**
1. `ALTER TABLE items ADD COLUMN marca_id INT NULL` (+ grupos + modifiers).
2. `ADD COLUMN compartido BOOLEAN DEFAULT FALSE` (flag "compartido entre marcas").
3. Reemplazar el unique por `(tenant_id, COALESCE(marca_id,0), COALESCE(local_id,0), LOWER(nombre)) WHERE deleted_at IS NULL`.
4. `listItems` pasa a recibir `marcaId` y trae: items de esa marca **+** items con
   `compartido = true` del tenant.
5. Backfill: los 53 items de sushi → `marca_id = Neko`.
- Nada se rompe si `marca_id` arranca NULL y el filtro nuevo es aditivo.

## 8.2 Reportes y canales — qué hay y qué choca

**Hoy:**
- Todos los reportes COMANDA filtran por **un** `localId` (RPCs `fn_reporte_*` con
  `p_local_id`). No hay "varios locales sumados". `useLocalActivo` = un local a la vez.
- `canales` e `item_precios_canal` tienen `tenant_id` + `local_id` NULL/N. El precio
  se resuelve en `fn_agregar_item_comanda`: busca `item_precios_canal` por el
  `canal_id` de la venta; si no hay, cae a `precio_madre`. **Ya funciona.**
- `ventas_pos` tiene `local_id` + `canal_id`. La marca se **deriva** del local.

**Choca con el modelo marca:** para ver "reportes de Neko" (sus 3 sucursales
sumadas) hace falta filtrar por **el conjunto de locales de la marca**, no por uno.

**Cómo se modifica sin romper:**
1. Las RPCs `fn_reporte_*` pasan de `p_local_id INTEGER` a `p_local_ids INTEGER[]`
   (`WHERE local_id = ANY(...)`). Backward-compatible (un solo id sigue andando).
2. `ReportesLayout` agrega un **selector de marca**; la marca expande a su lista de
   locales y se la pasa a las RPCs. Sigue existiendo el drill-down a un local.
3. **Canales NO cambian de modelo** — quedan `tenant_id + local_id (NULL/N)`. Solo
   si en el futuro querés precios distintos por marca dentro del mismo canal, se
   agrega `marca_id` opcional a `item_precios_canal`. Por ahora no hace falta.

## 8.3 Insumos / recetas / stock / compras — qué hay y qué choca

**Hoy (¡ya alineado!):**
- `insumos`, `recetas`, `materias_primas`, `proveedores` = **compartidos a nivel
  tenant** (NULL = global, con override por local posible). ✔ es lo que queremos.
- **Stock ES por local**: `insumo_movimientos.local_id` + cache `insumo_stock_local
  (insumo_id, local_id)`. Las compras (facturas) entran stock al local de la factura;
  hay transferencias entre locales. ✔ es lo que queremos.
- CMV teórico es por item (snapshot de receta), agnóstico al local. ✔

**Choca con el modelo marca:** **casi nada.** Insumos/recetas/proveedores quedan
compartidos en el tenant (sirven a todas las marcas), y el stock sigue por local.
NO hace falta `marca_id` en insumos, recetas ni stock.

**Único punto a decidir:** si querés que un insumo de Rene sea *invisible* para Neko
(separación visual por marca), habría que filtrar por marca en la UI de insumos.
Recomendación: **no** — dejarlos compartidos (un "salmón" sirve a todas las marcas);
lo que separa es el stock por local, que ya está.

## 8.4 Acceso de usuarios — qué hay (lo mejor: ya soporta lo transversal)

**Hoy:**
- `usuario_locales` (m:n) ya permite que **un usuario tenga varios locales**.
- `auth_locales_visibles()` devuelve el array de locales del usuario (NULL = dueño/
  admin ve todos). La RLS de cada tabla con `local_id` ya usa esto.
- Dueño/admin ven todo; encargado ve sus locales (con modal de elegir local si >1).

**Choca:** nada en lo de fondo. Falta solo **UX**: poder asignar "acceso por marca"
(atajo = todos los locales de esa marca) en vez de tildar local por local.

**Tu caso del comprador/admin transversal:** ya soportado. Se le asignan los locales
de Neko + Maneki + Rene en `usuario_locales` y ve/maneja las 3. Como todo está en el
mismo tenant, las compras/insumos compartidos le aparecen sin nada extra.

## 8.5 Tabla maestra de cambios

| Subsistema | ¿Choca? | Cambio | Riesgo |
|---|---|---|---|
| Menú (items/grupos/modifiers) | Sí | + `marca_id` + `compartido`, nuevo unique, `listItems` por marca, backfill | Medio |
| Reportes | Sí | RPCs `p_local_ids[]` + selector de marca | Medio |
| Canales / precios | No | Sin cambios (opcional `marca_id` futuro) | — |
| Insumos / recetas / proveedores | No | Quedan compartidos en tenant | — |
| Stock | No | Ya es por local | — |
| Acceso usuarios | Parcial | Solo UX "asignar por marca"; backend ya sirve | Bajo |
| `locales` | Sí | + `marca_id` (FK a marcas) | Bajo |
| RLS | Parcial | Sigue por `local_id`; marca se deriva del local. Solo el menú suma chequeo de marca | Medio |

## 8.6 Qué AGREGAR para que tenga sentido (resumen)

1. **Tabla `marcas`** (`tenant_id`, nombre, slug, logo_url, color_primary, orden).
2. **`locales.marca_id`** → cada sucursal pertenece a una marca.
3. **`items/item_grupos/modifier_groups`**: `marca_id` + `compartido` + unique nuevo.
4. **`listItems`/`listGrupos`** del POS: resolver menú por marca del local activo
   (marca + compartidos del tenant).
5. **RPCs de reportes**: aceptar `p_local_ids[]`; UI con selector de marca.
6. **Branding por marca**: la UI lee logo/colores de la marca activa.
7. **UX de acceso por marca**: atajo para asignar todos los locales de una marca.
8. **Tests E2E nuevos** (hoy NO existe assert de aislamiento de menú entre locales):
   - encargado de marca A no ve menú de marca B
   - item con `compartido=true` visible en todas las marcas
   - usuario multi-local ve el menú correcto según el local activo

## 8.7 Lo que NO hay que hacer (trampas detectadas)

- ❌ `marca_id NOT NULL` sin default ni backfill → rompe todos los items actuales.
- ❌ Cambiar el unique de items sin migrar antes → violaciones de constraint.
- ❌ Meter `marca_id` en `insumos`/`recetas`/`stock` → innecesario, complica de gusto.
- ❌ Mover datos operacionales (ventas/caja/sueldos) entre tenants → no aplica en
  este modelo; todo se queda donde está, solo se agrega la dimensión marca arriba.
- ❌ Agregar `marca_id` a `ventas_pos` → la marca se deriva del `local_id` con un
  JOIN; no hace falta denormalizar.

---

# 9. USUARIOS Y ACCESOS (multi-marca) — 2026-06-30

> Pieza clave: el modelo de acceso es lo que sostiene "una persona maneja varias
> marcas". Analizado a fondo el modelo actual + comparado con Toast.

## 9.1 Aclaración que SIMPLIFICA todo

El análisis técnico inicial asumió "marca = tenant" y listó un montón de trabajo
multi-tenant (switch de tenant, `usuario_locales` por tenant, roles por tenant,
`tenant_admins`, etc.). **Eso NO aplica a nuestro modelo**: las marcas son una capa
**dentro de un mismo tenant** (el grupo/dueño). Por lo tanto:

- Una persona pertenece a **UN tenant** (el grupo). No hay que cambiar de cuenta.
- "Acceso a varias marcas" = acceso a los **locales** de esas marcas, todos en el
  mismo tenant. **Ya funciona** con `usuario_locales` (m:n usuario→locales).
- **No hace falta** `tenant_admins`, ni selector de marca en el login, ni roles por
  tenant, ni `apps_permitidas` por tenant. Todo eso se evita.

## 9.2 Los niveles de acceso (cómo funciona hoy)

Hay **dos llaves separadas** (igual que Toast):

**A) Back-office / web** — la app **Accesos** (del dueño) gestiona las *personas*:
- `usuarios` (login web): email + `rol` / `rol_id` (RBAC) + `apps_permitidas[]`
  (a qué apps del ecosistema entra: PASE/COMANDA/MESA/Habitué/Accesos) +
  `cuentas_visibles[]`.
- `roles` + `rol_permisos`: catálogo RBAC (dueño, socio, administrador, encargado,
  cajero, contador). El permiso se hereda del rol.
- `usuario_locales` (m:n): a qué **sucursales** ve/opera cada persona. ⬅ **esta es la
  llave del multi-marca**.

**B) POS (terminal)** — el **PIN**:
- `rrhh_empleados` con `pos_activo`, `rol_pos` (cajero/encargado/manager/dueño/
  bartender), `pin_pos` (bcrypt). **El PIN es por local** (UNIQUE `local_id, pin`).
- Permisos POS por `rol_pos` (`rol_pos_permisos`).
- Login: elegís local → 4 dígitos → `fn_verificar_pin_pos(local_id, pin)`.

Tener acceso web NO da acceso al POS y viceversa — **idéntico a Toast** (Web Access
Role vs POS Job Role, dos capas independientes).

## 9.3 Cómo lo hace Toast (referencia)

- Dos capas: **POS job role (passcode)** + **web access role**, independientes. ✔ igual.
- Permisos **por rol/job**, heredados; override por persona y por local. ✔ tenemos rol
  + override por `usuario_permisos`.
- Empleado **agregado a N locales**; un passcode sirve en cada local. (Nosotros: PIN
  por local — ver brecha abajo.)
- **Super user / gatekeeper** a nivel grupo (dueño/GM con todo). ✔ rol dueño/admin.
- Acceso a un local = "agregar la persona a ese local". ✔ `usuario_locales`.

## 9.4 El diseño multi-marca de accesos (lo que hay que hacer)

Como marca = grupo de locales en el mismo tenant, el acceso se resuelve casi todo con
lo existente. Lo que se agrega:

1. **Asignar acceso "por marca" (UX en Accesos)** — hoy se asignan locales sueltos.
   Agregar un atajo: tildar **marca Neko** = asignar todos sus locales a la persona;
   o elegir locales puntuales. Internamente sigue siendo `usuario_locales` (no cambia
   el modelo de datos, solo la UI de asignación).
2. **Filtros por marca en las pantallas** — listas de empleados, reportes, etc. con
   selector de marca (que expande a sus locales). Ver sección 8.2/8.4.
3. **POS multi-marca (la única brecha real):** una persona que trabaja en 2 marcas
   necesita PIN en los locales de ambas. Hoy el PIN es por local y la persona puede
   tener varios `rrhh_empleados` (uno por local). **Decisión a tomar:**
   - **Opción simple (recomendada):** la persona usa el **mismo PIN** en los locales
     donde está habilitada (se crea/copia el `rrhh_empleados` con PIN en cada local).
     En el login del POS ya elegís el local primero → resuelve solo. Es lo más parecido
     a Toast ("un passcode en cada local agregado").
   - Opción robusta (futuro): unificar el PIN a nivel persona en vez de por
     `rrhh_empleados`. Más trabajo; no necesario para arrancar.
4. **`apps_permitidas` queda global** (a qué apps entra la persona) — no hace falta
   por marca. Si en el futuro querés "esta persona ve COMANDA solo de Neko", se
   resuelve por locales, no por apps.

## 9.5 Qué NO hay que hacer (se evita por el modelo de grupo)

- ❌ Selector de marca en el login / switch de tenant.
- ❌ `usuario_locales`, `usuario_permisos`, `apps_permitidas` "por tenant".
- ❌ Usar `tenant_admins` (queda como está, sin tocar).
- ❌ Roles distintos por marca para la misma persona (si se quisiera, es override por
   local vía `usuario_permisos`, no una tabla nueva).

## 9.7 Restricciones de Lucas (30-jun) — NO romper esto

**A) El menú se interrelaciona con TODO (constraint para Fase 2 "menú por marca"):**
Cuando se haga el menú por marca, debe **mantener** lo que ya funciona:
- Cada item vive en **canales** (Salón / Mostrador / Take away / Rappi / PedidosYa /
  etc.) con su lista de precios → eso NO se toca, sigue por canal.
- **Apagar un item en el POS (agotado) debe propagarse** a sus canales (que no se
  pueda vender en Rappi/PeYa si está agotado). Hoy `items.estado='agotado'` ya es
  global al item → se respeta.
- Esos productos **salen en los reportes** y se usan para el **CMV según cantidad
  vendida** (receta × ventas). El `marca_id` se AGREGA arriba del item; NO debe
  cambiar cómo ventas→reportes→CMV se calculan.
- Regla: el `marca_id` es una **dimensión nueva**, no un reemplazo. Todo lo de
  canales/agotado/ventas/CMV queda igual.

**B) Reportes por marca CHOCAN con el selector de sucursal del sidebar — NO se hace
ahora.** El sidebar ya permite elegir en qué sucursal operás. Un "ver todas las
sucursales de la marca juntas" contradice eso: no pueden convivir en el mismo lugar
**a menos que se elimine el filtro del sidebar**. Decisión 30-jun: **dejar los
reportes como están (por sucursal)**. Reportes-por-marca queda **diferido** hasta
que Lucas decida si saca el filtro per-local del sidebar. NO agregar agregaciones
cross-local que peleen con el selector.

## 9.6 Resumen para Lucas

**Una persona = un login en el grupo.** Le das acceso a las **marcas** marcando sus
**locales** (atajo "por marca" en Accesos). Para el **POS**, esa persona tiene PIN en
los locales donde trabaja (mismo PIN en todos, elegís local al entrar). El back-office
y el POS son **dos llaves separadas** — igual que Toast. El 90% ya está construido;
lo nuevo es: el **atajo de asignar por marca**, los **filtros por marca**, y decidir el
**PIN multi-local** (recomendado: mismo PIN replicado por local).
