# PASE — Route / Page Mapping

> SuperDesign init file. Extracted from `src/App.tsx`.

## Code-split pages

All pages are lazy-loaded with `React.lazy()` except `Login` (eager — entry point for unauthenticated users).

## Route table

| Path | Component | Section | Notes |
|------|-----------|---------|-------|
| `/` | `<DefaultRedirect>` | — | Redirects to `/inicio` for authenticated users |
| `/inicio` | `DashboardHome` | Dashboard | Personalized by role. Receives usuario, permisos, locales, localActivo |
| `/caja/*` | `Caja` | Operacion | Has sub-routes (wildcard) |
| `/compras/*` | `Compras` | Operacion | Has sub-routes (wildcard) |
| `/ventas` | `Ventas` | Operacion | |
| `/gastos` | `Gastos` | Operacion | |
| `/equipo` | `RRHHPage` | Operacion | RRHH module (employees, sueldos) |
| `/recetario` | `Recetario` | Operacion | Hub: Insumos + Recetas with side-nav |
| `/negocio` | `Negocio` | Direccion | |
| `/finanzas` | redirect -> `/negocio` | Direccion | Legacy redirect |
| `/conciliacion-extracto` | `ConciliacionExtracto` | Direccion | Requires "conciliacion" permission |
| `/rentabilidad` | `Rentabilidad` | Direccion | |
| `/objetivos` | `Objetivos` | Direccion | |
| `/reportes` | `EERR` | Direccion | P&L / EERR reports |
| `/cashflow` | `Cashflow` | Direccion | |
| `/utilidades` | `Utilidades` | Direccion | |
| `/ayuda` | `Ayuda` | Sistema | |
| `/herramientas` | `HerramientasHub` | Herramientas | |
| `/herramientas/contador-iva` | `Contador` | Herramientas | |
| `/herramientas/blindaje` | `Blindaje` | Herramientas | |
| `/herramientas/conciliacion-bancaria` | `ConciliacionBancaria` | Herramientas | |
| `/herramientas/importar` | `Importar` | Herramientas | |
| `/herramientas/lector-mp` | `LectorExtractoMP` | Herramientas | |
| `/ajustes` | `Ajustes` | Sistema | |
| `/ajustes/dashboards` | `SettingsDashboards` | Sistema | Requires "ajustes_dashboards" permission |
| `/ajustes/notificaciones` | `ConfiguracionNotificaciones` | Sistema | |
| `/ajustes/codigos-manager` | `CodigosManager` | Sistema | Dueno/admin/superadmin only |
| `/usuarios` | `Usuarios` | Sistema | Requires "usuarios" permission |
| `/usuarios/roles` | `RolesPermisos` | Sistema | |
| `/tenants` | `Tenants` | Sistema | Superadmin only |
| `/maxirest` | `ImportarMaxirest` | — | Requires "ventas" permission |
| `/onboarding` | `Onboarding` | — | Wizard for new tenants |
| `/aprobar-solicitud/:id` | `AprobarSolicitud` | — | Mobile-first approval deeplink |
| `/solicitudes` | `Solicitudes` | — | |
| `/mensajeria` | `MensajeriaIG` | — | Instagram bot messaging |
| `/sueldos-preview` | `SueldosPreview` | — | Interactive mockup (read-only) |
| `#/design-system` | `DesignSystem` | Dev | Hash-route dev preview |
| `*` | `<NotFoundRedirect>` | — | Catch-all -> default redirect |

## Legacy redirects

- `/reservas` -> `/inicio`
- `/usuarios-comanda` -> `/inicio`
- `/insumos` -> `/recetario?sec=insumos`
- `/materias-primas` -> `/recetario?sec=materias-primas`
- `/recetas` -> `/recetario?sec=recetas`
- Additional entries from `LEGACY_REDIRECTS` map in `src/lib/sidebar-nav.ts`

## Sidebar sections

The sidebar groups nav items into 4 sections:
1. **Operacion** — Inicio, Caja, Compras, Ventas, Gastos, Equipo, Recetario
2. **Direccion** — Negocio, Conciliacion, Objetivos, Reportes, Cashflow, Utilidades, Rentabilidad
3. **Herramientas** — Herramientas hub
4. **Sistema** — Ajustes, Ayuda, Usuarios, Tenants

Items are filtered by user permissions (`tienePermiso`) and tenant feature flags (`SLUG_TO_FEATURE` map).
