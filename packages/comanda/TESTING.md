# Testing — COMANDA

## Comandos

```bash
# Tests sin coverage (más rápido, default)
pnpm test

# Tests con coverage
node_modules/.bin/vitest run --coverage
```

> Nota: `pnpm test --coverage` no funciona porque turbo intercepta el flag.
> Usar el binario directo de vitest para coverage.

## Reporte

- **Texto en consola**: tabla con % por archivo + summary global.
- **HTML interactivo**: `coverage/index.html` (abrir en navegador).
- **JSON summary**: `coverage/coverage-summary.json` (para CI/herramientas).

## Thresholds actuales (sprint 8)

| Métrica     | % mínimo |
|-------------|----------|
| Lines       | 25%      |
| Functions   | 25%      |
| Branches    | 25%      |
| Statements  | 25%      |

Si los tests bajan de estos % en algún PR, vitest falla con exit 1.

## Foco

`include: ['src/services/**', 'src/lib/**']` — solo lógica crítica.
UI no se cuenta (cambia mucho, los tests UI requieren `@testing-library/react`
que aún no está instalado y no es prioritario).

## Roadmap de coverage

- **Sprint 9**: subir thresholds a 35%.
- **Sprint 10**: subir a 45%.
- **Pre-launch SaaS**: 60% en services y lib críticos.

## Servicios con coverage destacable post-sprint 8

| Service             | Lines % |
|---------------------|---------|
| descuentosService   | 94%     |
| kdsService          | 100%    |
| menuQrService       | 76%     |
| pagosService        | 71%     |
| empleadosService    | 54%     |
| metodosCobroService | 69%     |
| ventasService       | 26%     |
| mesasService        | 24%     |
| overridesService    | 10%     |

## Servicios SIN tests (próximos sprints)

- allChecksService, canalesService, combosService, configService,
  itemsService, kdsTokensService, localSettingsService,
  menuQrTokensService, modifiersService, recetasService,
  recetaPasosService, settingsLocalesService, tiendaService.

## Tests SQL/integration con DB real

Los tests actuales mockean Supabase a nivel JS. NO testean:
- Triggers (ej. el trigger de reverso de movimientos del sprint 8).
- CHECK constraints.
- RLS policies.
- Race conditions reales con `FOR UPDATE`.

Para esto hace falta Supabase local + scripts seed + suite de
integration. Anotado en deuda como "tests SQL reales".
