# Análisis de lógica — Usuarios/Roles/Permisos + pantalla Ajustes

**Fecha:** 2026-06-11
**Tipo:** auditoría de arquitectura de producto (decisiones de diseño, no bugs)
**Alcance:** pantalla Ajustes (catálogos de configuración), Usuarios, Roles y permisos de PASE, usuarios y permisos de COMANDA, onboarding de tenant nuevo
**Archivos leídos:** `Ajustes.tsx`, `Usuarios.tsx`, `Config.tsx`, `RolesPermisos.tsx`, `Onboarding.tsx`, `src/lib/auth.ts`, `useCategorias.ts`, `useMediosCobro.ts`, COMANDA `usePermiso.ts` + `UsuariosPosPage.tsx` + carpeta `Settings/`, migraciones `20260417_config_categorias`, `20260424_medios_cobro_catalogo`, `202605151740_rol_pos_permisos`, `202605201900_rbac_roles`, `202605240000_comanda_usuarios`, `202605241000`, `202605271500_sincronizar_permisos_usuario`, `202605292030`, `202606111000_socio_rentabilidad`, `202605102318_rpc_crear_tenant_v2`, spec `2026-05-28-permisos-unificados-rediseno.md`

---

## 1. Cómo funciona hoy (el mapa en 2 minutos)

### 1.1 Ajustes

La pantalla es un **lector/editor de 3 tablas de catálogo**, presentadas como 6 grupos colapsables con un buscador global:

| Grupo | Tabla | Alcance | Items hoy |
|---|---|---|---|
| Categorías de gastos | `config_categorias` (7 sub-tipos: fijo/variable/publicidad/comisión/impuesto/retiro socio/juicios) | por tenant | 62 |
| Categorías de compras | `config_categorias` (tipo `cat_compra`) | por tenant | 27 |
| Categorías de ingresos | `config_categorias` (tipo `cat_ingreso`) | por tenant | 11 |
| Medios de cobro | `medios_cobro` | global del tenant + override por local | 23 |
| Puestos del equipo | `rrhh_puestos` | por tenant | 10 |
| Turnos y horarios | **no existe tabla** | — | 0 (placeholder "próximamente") |

Mecánica: crear con modal contextual ("+ Nuevo en…"), editar nombre, cambiar sub-tipo de gasto con un pill-select inline, eliminar = soft delete (`activo=false`, el historial conserva el texto). Los formularios del resto de la app consumen estos catálogos vía hooks (`useCategorias`, `useMediosCobro`) con cache de 1 hora + invalidación Realtime + **fallback a listas hardcodeadas en `constants.ts`** si la base devuelve vacío.

### 1.2 Permisos PASE — cuatro mecanismos superpuestos

1. **Rol legacy** (`usuarios.rol` texto): `dueno`/`admin` = bypass total; `encargado`/`cajero`/`compras` tienen listas hardcodeadas en `ROLES` de `auth.ts`.
2. **Permisos sueltos** (`usuario_permisos`): checkboxes por usuario (módulos + permisos avanzados tipo `caja_anular`, `ver_anulados`).
3. **Roles RBAC** (`roles` + `rol_permisos` + `usuarios.rol_id`, migración 20-may): 6 roles del sistema (Dueño, Socio, Administrador, Encargado, Cajero, Contador) + roles custom por tenant, gestionados en `/usuarios/roles`. Editar un rol cambia al instante a todos los usuarios que lo tienen (referencia viva, no copia).
4. **Atajos hardcodeados** en `tienePermiso()`: ~8 slugs (`importar`, `lector_mp`, `codigos_manager`, `conciliacion`, `herramientas_hub`, etc.) que se resuelven por código, no por tabla.

La semántica efectiva es **OR de todo**: rol legacy ∪ rol RBAC ∪ sueltos (fix `unirPermisos` del 11-jun alineó el frontend con `auth_tiene_permiso` del backend). A eso se suman dos ejes ortogonales por usuario: **cuentas de Tesorería** (ver saldo / operar, dos listas) y **sucursales** (`usuario_locales`).

### 1.3 Permisos COMANDA — un sistema aparte (y con dos vocabularios internos)

- `comanda_usuarios` con `rol_pos` ∈ {mozo, cajero, manager, admin}. **Solo `admin` otorga algo por sí mismo** (bypass); mozo/cajero/manager son etiquetas: los permisos reales son checkboxes por usuario en `comanda_usuario_permisos` (catálogo de 15 slugs `comanda.*`).
- Además existe `rol_pos_permisos` (15-may), que mapea **otro** enum de roles ({cajero, encargado, manager, dueno, bartender}, el de `rrhh_empleados`) a slugs, y lo usa el frontend para sesiones POS por PIN.
- O sea: dentro de COMANDA conviven **dos nociones distintas de "rol_pos"** según cómo entraste (login Supabase vs PIN), y el backend (`comanda_auth_tiene_permiso`) solo mira admin-bypass + slugs sueltos.

### 1.4 Crear el equipo hoy: tres altas por persona

Para un empleado típico (cajera que cobra en el POS y figura en sueldos) hay que crearla **tres veces**, sin vínculo automático entre las tres:

1. `/equipo` (PASE): legajo RRHH para liquidar sueldos.
2. `/usuarios` (PASE): solo si necesita entrar al back-office (rol + sucursales + cuentas).
3. COMANDA → Empleados → Usuarios POS: usuario POS (rol_pos + PIN + checkboxes de permisos), en **otra app**.

### 1.5 Onboarding y tenant nuevo

El wizard `/onboarding` guía 5 pasos (datos del local, primer empleado, primer insumo, primer item, primer canal). **No toca los catálogos de Ajustes ni la creación de usuarios.** Y `crear_tenant_v2` crea tenant + dueño + local, **pero no siembra ninguna categoría, medio de cobro ni puesto**.

---

## 2. Veredicto por área

### 2.1 Mecánica de la pantalla Ajustes — ✅ Bien resuelta

Buscador global con highlight, grupos colapsables persistidos, creación contextual, soft delete que no rompe historial, edición optimista con rollback. Es simple y honesta. El patrón de `medios_cobro` (fila global + override por local que gana, incluso para desactivar) es exactamente el estándar de los sistemas multi-sucursal. No hay nada que rehacer en la UI.

### 2.2 El contenido de los defaults — 🔴 No hay defaults: hay datos de Neko

Este es el hallazgo más importante del área Ajustes:

- Las "62 categorías de gastos" no son un template de producto: son **el plan de cuentas real del restaurante de Lucas** (EDESUR, METROGAS, WOKI, AQA, PIMENTON, SUSHIMAN PM, BARRIO CHINO…). Crecieron por uso, no por diseño.
- Un **tenant nuevo arranca con CERO categorías** (`crear_tenant_v2` no siembra nada). Y como `useCategorias` hace fallback a `constants.ts` cuando la DB devuelve vacío, el cliente nuevo ve en los formularios… **las categorías hardcodeadas de Neko**, que no existen en su base: una mezcla de pantalla vacía en Ajustes + dropdowns con categorías ajenas que al usarlas no matchean nada. Día 1 roto/confuso.
- 62 categorías de gastos **abruma** incluso para Neko: el estándar restaurantero (Toast/R365/plan de cuentas NRA) trabaja con 20-30 líneas agrupadas por renglón del P&L. Más categorías = más decisiones por cada gasto cargado = más miscategorización, no más insight.

### 2.3 "Turnos y horarios (0)" — ⚠️ Placeholder que confunde

No existe tabla ni CRUD; el contador "0" y el texto "próximamente" están hardcodeados. Para Lucas es una nota mental; para un cliente nuevo es una sección rota. Las secciones futuras no se muestran vacías en un producto vendible: se ocultan o se muestran con un CTA claro de "función en camino" fuera del flujo principal.

### 2.4 Renombrar categorías no propaga — ⚠️ Decisión asumida pero con costo creciente

Los gastos/facturas guardan la categoría como **texto**, no FK. Renombrar "EDESUR" → "Luz" en Ajustes solo cambia el catálogo: todo el historial queda con el nombre viejo, y el EERR/los filtros muestran dos líneas distintas para la misma cosa. Hoy es manejable; con 2 años de historia y clientes externos renombrando, es fragmentación silenciosa de reportes. (Mismo trade-off documentado en el código, pero conviene decidirlo conscientemente ahora.)

### 2.5 ¿Config centralizada? — ⚠️ Ajustes es solo una de ~6 puertas

Lo que un dueño llamaría "configuración" hoy vive en:

- **Ajustes**: catálogos (esta pantalla) + link a Notificaciones.
- **/ajustes/dashboards**, **/ajustes/codigos-manager**: rutas aparte, accesibles desde el hub Herramientas.
- **/negocio**: datos del local (dirección, etc.).
- **/usuarios** y **/usuarios/roles**: usuarios y roles (no linkeados desde Ajustes).
- **COMANDA → Settings**: 12 pantallas (local, mesas, KDS, estaciones, AFIP, recibos, branding, permisos, métodos de cobro…).
- **COMANDA → Catálogo**: items, canales, precios.

Es defendible que la config del POS viva en el POS. Lo que no es defendible:

- **Medios de cobro existe DOS veces**: `medios_cobro` (PASE, 23 items, pantalla Ajustes) y `metodos_cobro` (COMANDA, tabla y pantalla propias). Mismo concepto de negocio, dos catálogos sin puente. Cuando las ventas de COMANDA alimenten los reportes de PASE (la integración pendiente), cada venta va a referenciar un catálogo que Ajustes no conoce. Conciliar eso retroactivamente es caro.
- "Puestos del equipo" (Ajustes, `rrhh_puestos` = título de trabajo para el legajo) convive con "rol" (PASE) y "rol_pos" (COMANDA). Tres conceptos tipo-rol con nombres parecidos y sin explicación cruzada.

### 2.6 Modelo de permisos PASE: rol + extras — ✅ el modelo correcto, ⚠️ con 4 capas de historia encima

La dirección a la que se llegó (rol asignable + permisos sueltos que suman, roles del sistema + custom por tenant, edición de rol propaga al instante) **es el estándar de la industria** — es literalmente cómo funciona Square Team Permissions. El fix del 11-jun (unión rol+sueltos espejando el OR del backend) cerró la incoherencia más peligrosa.

Lo que sobra es la **acumulación**: rol legacy texto con listas hardcodeadas (`ROLES.admin.permisos`, `ROLES.compras`…), `Config.tsx` (pantalla vieja de usuarios, **hoy ni siquiera está ruteada — es código muerto** que todavía ofrece crear usuarios con roles admin/compras/cajero que la pantalla nueva ya no usa), y ~8 slugs resueltos por `if` dentro de `tienePermiso()` en vez de vivir en el catálogo de roles. Cuatro fuentes de verdad para responder "¿qué puede hacer este usuario?" hacen que cada bug de permisos (como el de Socio del 11-jun) requiera arqueología.

### 2.7 PASE vs COMANDA — 🔴 sí, son DOS sistemas de permisos (y COMANDA tiene dos adentro)

La separación de **identidad** (mismo Supabase Auth, perfiles distintos por app) fue una buena decisión del sprint del 24-may y es el modelo del spec #7. Pero la separación de **permisos** quedó a mitad de camino:

- Slugs con vocabularios distintos (`caja`, `compras` en PASE; `comanda.ventas.cobrar` en COMANDA), dos catálogos, dos UIs de asignación con UX distinta (dropdown de rol en PASE; checkboxes uno-por-uno en COMANDA donde el rol_pos manager **no otorga nada**).
- Dentro de COMANDA, el enum `rol_pos` de `comanda_usuarios` (mozo/cajero/manager/admin) no es el mismo que el de `rol_pos_permisos`/`rrhh_empleados` (cajero/encargado/manager/dueno/bartender). Según si el empleado entra con password o con PIN, sus permisos salen de tablas distintas con roles distintos.
- Del **spec #7** (permiso_catalogo unificado, sensibilidad NORMAL/SENSIBLE/CRITICO, audit log de cambios, 2FA para críticos, templates) se implementó **poco y por otro camino**: existe el RBAC de PASE (mejor incluso que los "templates copia" del spec, porque es referencia viva), existe el catálogo de slugs de COMANDA, y existe el Manager Override TOTP. No existe: catálogo unificado, sensibilidad, audit log de cambios de permisos, ni el alta de usuario unificada.

**¿Es sostenible?** Para Neko sí. Para vender, no: el dueño nuevo tiene que aprender dos modelos mentales y hacer el alta dos/tres veces por empleado.

### 2.8 ¿Un dueño nuevo arma su equipo de 5 en <5 minutos? — 🔴 No

Conteo real para 5 empleados (cajera, mozo, cocinero, encargada, contador):

- 5 legajos en `/equipo` (~1-2 min c/u: datos personales + sueldo) — necesario para sueldos.
- 1-2 usuarios PASE en `/usuarios` (encargada, contador): el modal es bueno (rol del dropdown + sucursal), ~1 min c/u. ✅ esta parte sí está a nivel.
- 3-4 usuarios POS en COMANDA (cajera, mozo, cocinero, encargada): **otra app**, otro modal, y acá el rol no alcanza — hay que tildar permisos slug por slug porque mozo/cajero/manager no traen nada por default. ~2-3 min c/u con dudas ("¿qué tildo para un mozo?").

Total realista: **20-30 minutos, en dos aplicaciones, con tres formularios distintos por persona y sin guía de qué tildar**. El estándar (Square Team, Toast Employees) es: un alta por persona, elegís el job/rol, el sistema deriva acceso a POS y back-office, listo en <1 min por empleado.

### 2.9 Multi-local / multi-tenant — ✅ coherente, con un faltante documentacional

- `config_categorias` y `rrhh_puestos`: por tenant (sin granularidad por local). Correcto para un plan de cuentas — no querés categorías distintas por sucursal.
- `medios_cobro`: global + override por local con la precedencia bien resuelta. ✅ el patrón correcto.
- RLS por tenant en todo, lectura abierta a todo el tenant (fix 12-may) y escritura gateada por permiso. ✅
- Lo confuso no es el scoping, es que **nadie se lo cuenta al usuario**: la pantalla Ajustes no dice qué es por-tenant y qué es por-local (el override por local de medios de cobro ni siquiera se puede gestionar desde Ajustes — la pantalla no muestra ni edita `local_id`).

---

## 3. Respuesta directa: "¿la lógica de cargado en Ajustes es la correcta o es mejorable?"

**La mecánica es correcta; el modelo de contenido es mejorable y una parte es directamente incorrecta para vender.**

- ✅ **Correcto**: catálogos en tablas (no hardcode), soft delete, buscador + grupos, override por local en medios de cobro, hooks con cache+Realtime. No tocar.
- ⚠️ **Mejorable**: 62 categorías de gastos es el doble de lo que recomienda la industria; la lista plana alfabética no muestra las que usás siempre vs las que usaste una vez; "Turnos (0)" confunde; renombrar no propaga al historial; la pantalla no es el hub real de configuración (usuarios/roles/notificaciones/COMANDA viven afuera y ni se linkean).
- 🔴 **Incorrecto para un cliente nuevo**: hoy no existen defaults de producto. Tenant nuevo = catálogos vacíos + fallback con las categorías de Neko en los dropdowns. La respuesta estándar (Toast, Square, R365) es **plantilla por tipo de negocio al crear el tenant**: 15-25 categorías de gastos con nombres genéricos (Alquiler, Luz, Gas, Agua, Internet, Seguros, Honorarios contables…), 8-10 medios de cobro base, 6-8 puestos típicos. Con eso, "crear-al-usar" (poder tipear una categoría nueva desde el form de Gastos, que ya existe parcialmente con quick-create) cubre el resto. La organización ideal de la pantalla no es por tabla sino por frecuencia: "lo que vas a tocar el primer día" (medios de cobro, puestos) arriba; el plan de cuentas (gastos/compras/ingresos) como bloque contable aparte.

---

## 4. Decisiones a cambiar AHORA (baratas hoy, caras después)

Ordenadas por relación costo-de-esperar / costo-de-hacer:

1. **Seed de catálogos en `crear_tenant_v2` + matar el fallback de Neko.** Una migración con template genérico AR (gastos ~20, compras ~10, ingresos ~6, medios ~10, puestos ~8) que se inserta al crear tenant. El fallback de `constants.ts` debe quedar solo para Neko o eliminarse: mostrar el plan de cuentas de otro restaurante es un leak conceptual. *Costo hoy: 1 día. Costo después: cada cliente nuevo onboardeado a mano + primera impresión rota.*
2. **Un solo catálogo de medios de cobro antes del piloto COMANDA.** Decidir: `medios_cobro` (PASE) es la verdad y COMANDA la consume (consistente con la directiva "todo el catálogo en PASE, COMANDA consume"), o al revés. Cada venta del piloto registrada contra `metodos_cobro` separado es deuda de conciliación retroactiva. *Costo hoy: días. Costo después: migrar datos de ventas reales.*
3. **Un alta de persona, no tres.** Mínimo viable: desde el alta de empleado en `/equipo`, checkboxes "¿usa el POS?" (crea `comanda_usuarios` con rol→permisos default) y "¿entra al back-office?" (crea `usuarios` con rol). Vincular las tres filas por `auth_id`/persona. Es la sección 5.5 del spec #7 y es **lo único del spec que urge**. *Costo hoy: un sprint. Costo después: cada cliente lo sufre en su primer día y cada des-sincronización (empleado dado de baja en RRHH pero activo en POS) es un riesgo real.*
4. **Que el rol_pos de COMANDA otorgue permisos.** Seedear defaults por rol (mozo/cajero/manager) en el alta —o leer `rol_pos_permisos` desde el backend— y unificar los dos enums de rol_pos en uno. Hoy "manager" en el backend de COMANDA no significa nada, y eso es una trampa para quien configure usuarios sin tildar todo.
5. **Una sola fuente de verdad de permisos en PASE.** Deprecar las listas hardcodeadas de `ROLES` (migrar esos 3 roles legacy a `rol_id`), borrar `Config.tsx` (código muerto), y mover los ~8 slugs hardcodeados de `tienePermiso()` al catálogo/roles. No hace falta el spec #7 completo (sensibilidad, 2FA, audit log pueden esperar); sí hace falta que la pregunta "¿qué puede hacer X?" tenga UNA respuesta.
6. **Ocultar "Turnos y horarios"** hasta que exista, y linkear desde Ajustes lo que el usuario espera encontrar ahí (Usuarios, Roles, Notificaciones, y un link saliente "Configuración del POS → COMANDA").
7. **Decidir el rename de categorías**: o propagar el rename al historial (UPDATE masivo del texto, simple), o migrar a FK por id. Cualquiera de las dos; lo caro es no decidir y acumular historia fragmentada.

---

## 5. Comparación con el estándar (Toast / Square)

| Tema | Toast / Square | PASE+COMANDA hoy |
|---|---|---|
| Alta de empleado | 1 registro por persona; el job/rol deriva acceso a POS y back-office, passcode POS incluido | 3 registros en 2 apps sin vínculo |
| Roles | Sets de permisos predefinidos + custom, referencia viva (Square) — editás el rol, cambia para todos | ✅ PASE RBAC ya funciona así; COMANDA no (checkboxes por usuario) |
| Rol + excepciones por usuario | Sí (estándar) | ✅ implementado en PASE (11-jun) |
| Plan de cuentas default | 15-30 categorías genéricas por tipo de negocio, seed al crear cuenta | 0 categorías reales + 62 de Neko como fallback |
| Payment types | Un catálogo, compartido entre POS y reportes | Dos tablas (`medios_cobro` / `metodos_cobro`) |
| Settings | Un hub central con secciones; lo del POS puede vivir en el POS pero se navega desde un solo índice | ~6 puertas sin índice común |
| Permisos sensibles | Niveles/flags con fricción extra (PIN de manager) | TOTP manager override ✅ (COMANDA); sensibilidad por permiso del spec #7 sin implementar |
| Audit de cambios de permisos | Sí | No (existe solo para overrides) |

**Síntesis:** la arquitectura de a dónde se quiere llegar (spec #7 + RBAC actual) es la correcta y comparable al estándar. El gap vendible no es de diseño sino de terminación: defaults de tenant nuevo, un solo alta de persona, un solo catálogo de medios de cobro, y una sola fuente de verdad de permisos por app.
