# Product

## Register

product

## Users

PASE es el back-office del ecosistema gastronómico **Cocina** (PASE + COMANDA + MESA + Habitué + Accesos). Lo usan tres perfiles, todos en sesiones largas de escritorio:

- **Anto (dueña / asistente del dueño)** — usuaria principal del día a día. Carga facturas, paga sueldos, concilia MercadoPago, mira el EERR, decide qué cuenta paga qué. Conoce el negocio de memoria; necesita la app para no olvidarse de cosas y para que los números cuadren al cierre del mes.
- **Encargados de local** — gestionan UN local específico (restringidos por `usuario_locales` + RLS + cuentas visibles). Cargan ventas, gastos del día, cierres de caja. Nunca operan con `localActivo=null` (modal bloqueante de selección).
- **Cajeros** — rol mínimo, casi siempre operan desde COMANDA (POS). En PASE entran solo a tareas puntuales (consultar saldo, ver una venta).
- **Dueño / admin (Lucas)** — control total, configuración del sistema, gestión de tenants y usuarios.

Contexto de uso: escritorio (no mobile), sesiones largas, **plata real en juego** en cada acción. Tablas grandes con histórico, formularios densos, decisiones recurrentes (pagar este mes, conciliar este día, cerrar este período).

## Product Purpose

PASE reemplaza el stack heredado (Excel + Maxirest + WhatsApp + papelitos) con un solo sistema honesto de gestión gastronómica para PyMEs argentinas.

Cubre el ciclo completo: **ventas** (manual + import Maxirest), **gastos**, **facturas** (con lector IA Opus 4.7), **remitos**, **RRHH** (sueldos punta a punta: novedades, liquidación, vacaciones, aguinaldo, liquidación final, adelantos), **caja y bancos**, **conciliación MercadoPago** (sync automático cada 30 min vía GitHub Actions), **EERR base devengada con drill-down**, **simulador de escenarios**, **utilidades/reparto entre socios**, **cierre/bloqueo de mes**, **insumos / recetas / CMV**, **stock por local**, y un **bot de diagnóstico IA** con tool use que mira la base read-only para responder dudas operativas.

Multi-tenant (escala a otros restaurantes) y multi-local por tenant (cada negocio puede tener varias sucursales con aislamiento estricto vía RLS + `applyLocalScope` + modal de selección). Éxito = Anto cierra el mes sin pedirle nada a nadie; el dueño abre el EERR y entiende dónde se fue la plata; un encargado nuevo no rompe nada aunque tenga acceso solo a su local.

Estado actual: **en producción** con un local activo (Rene Cantina, abrió mayo 2026) y preparándose para piloto con otros tenants.

## Brand Personality

**Calm, sereno, argentino sin folklorismo.** Tres palabras: **honesto**, **calmo**, **nacional**.

- **Voz**: español rioplatense neutro, sentence case, primera persona del plural cuando hay acción colaborativa ("falta confirmar el cierre"). Nunca jerga developer, nunca cripto-marketing, nunca optimismo de growth-hacker. Le habla a Anto.
- **Tono visual**: cero gradientes, cero sombras profundas, bordes 0.5px, mucho whitespace, números grandes con tabular-nums. Bento asimétrico (un KPI ancla por pantalla, todo lo demás secundario) en vez de grids uniformes de cards iguales.
- **Identidad nacional como ancla, no como tema**: celeste bandera argentina IRAM 7677-2002 (#75AADB) es el ÚNICO celeste de marca; dorado moneda (#F5C518) aparece en exactamente 2 lugares (punto del logo `pase.` + indicador "en vivo" del KPI ancla) + tooltip. Paleta opcional cálida (crema/papel cuaderno) para fondos atmosféricos. Sin banderas, escudos, charangos ni emoji.
- **Confianza experta**: el sistema sabe lo que hace; muestra el número exacto sin gritar. Si hay incertidumbre real (factura por IA con baja confianza, conciliación con sobrante), se admite en el coloreado/copy del propio dato, no con notificaciones tipo bombero.
- **Modo oscuro = camiseta suplente de Argentina 2006** (navy graphite con anclas celeste/dorado idénticas al light mode).

## Anti-references

PASE **no debería parecerse** a:

- **POS / back-office legacy estilo Maxirest, Fudo, Bejerman** — tablas densas con bordes gruesos grises, dropdowns infinitos, paleta gris-azul corporativo Windows 2010, ningún whitespace, sensación de ERP de los 2000s.
- **SaaS genérico tipo dashboard de Stripe / Linear / Vercel** — mucho gris uniforme, jerarquía plana, todas las secciones iguales, "AI default" aesthetic, falta de personalidad y de ancla cultural.
- **Excel / pantalla contable** — datos sobre datos sin curado visual, color solo cuando algo está en rojo, sin jerarquía entre KPI ancla y dato secundario.
- **Dashboard pesado tipo Tableau / PowerBI / Looker** — gráficos decorativos por todos lados, KPIs ruidosos con porcentajes y comparaciones por todos lados, dataviz como objetivo en vez de medio.

Específicos de marca (ya en `DESIGN_SYSTEM.md`):

- Colores para distinguir roles de usuario (decisión 2026-05-13: solo texto).
- Cualquier celeste/azul que no sea exactamente #75AADB.
- Dorado fuera de los 2 lugares permitidos.
- Pesos tipográficos ≥600 (rompen el calm design).
- Negro puro o gris genérico para texto (siempre `--pase-text` / `--pase-text-muted`, tintados navy).
- ALL CAPS o Title Case (excepción única: link "VER TODO" en listado de movimientos).

## Design Principles

1. **Plata es sagrada** — toda interfaz que toca dinero pasa por una RPC atómica con error codes traducidos, muestra montos con `tabular-nums` + formato AR (`$1.234,56`), y deja huella en auditoría. Nunca un número "casi" formateado, nunca un movimiento sin trazabilidad. Si hay duda (conciliación con sobrante, factura por IA con confianza baja), la duda se **muestra**, no se esconde.

2. **Confianza experta sin ruido** — el sistema sabe lo que hace; muestra el número exacto sin gritar. Notificaciones, badges y alertas se usan con cuentagotas. Si todo está bien, la pantalla está calma. Si algo necesita atención, lo dice una sola vez, donde corresponde.

3. **Defense-in-depth se siente en la UX** — el aislamiento por local (3 capas: `usuario_locales` + RLS + modal bloqueante) está alineado con cómo se ve y se siente la app: el header siempre dice en qué local estás, los datos visibles son los que tu rol puede ver, los pagos por local hablan de "tu local". La seguridad no se esconde, pero tampoco fricciona donde no hace falta.

4. **Identidad nacional como ancla, no como tema** — celeste IRAM y crema opcional son el ancla; cualquier intento de "argentinizar" más allá de eso (banderas, escudos, copy patriótico, emoji) se rechaza. Argentina se siente en el tono, no en el cartel.

5. **Bento asimétrico como jerarquía** — cada pantalla principal tiene UN KPI ancla (Caja Efectivo del local, Facturación del mes, Utilidad del mes) y todo lo demás es secundario. Sin grids uniformes de cards iguales — ese patrón es SaaS genérico y rompe la jerarquía que cuenta lo que importa primero.

## Accessibility & Inclusion

**WCAG AA como piso**: contraste mínimo 4.5:1 en body / 3:1 en texto grande, focus ring visible en todos los interactivos, navegación por teclado funcional en flujos críticos (pagar sueldo, anular factura, conciliar MP, cerrar caja).

Sin caso de usuario específico reportado al día de hoy, pero el sistema lo usa Anto durante muchas horas seguidas (fatiga visual real): por eso los grises tintados navy en lugar de negro puro, `prefers-color-scheme` honrado, tipografía Inter en pesos 400/500, modo oscuro estable.

Animaciones (`row-focus-flash`, sparklines, entradas) respetan `@media (prefers-reduced-motion: reduce)` — defecto del sistema actual: no está implementado en todos los componentes; cuando se agreguen nuevas animaciones, son obligatorias las alternativas reducidas.

Idioma único: **español rioplatense**. Sin soporte multi-idioma planificado (cliente target: Argentina).
