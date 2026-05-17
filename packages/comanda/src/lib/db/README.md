# lib/db — DB local IndexedDB (Fase 1 offline-first)

DB local versionada que replica el modelo del POS para operación offline.
Es el cimiento del proyecto offline-first ([OFFLINE_FIRST_ARQUITECTURA.md](../../../OFFLINE_FIRST_ARQUITECTURA.md)).

## Layout

```
lib/db/
  schema.ts          - tipos + lista de stores + DB_VERSION
  migrations.ts      - migrations versionadas (idempotentes)
  index.ts           - getDb() singleton + resetDb()
  README.md          - este archivo
  repositories/
    base.ts          - BaseRepository<S> con CRUD + sync helpers
    itemsRepo.ts
    gruposRepo.ts
    mesasRepo.ts
    ventasRepo.ts    - exporta ventasRepo + ventasItemsRepo + ventasPagosRepo
    __tests__/
      itemsRepo.test.ts
      ventasRepo.test.ts
```

## Cómo usar desde components / services

**NO importes `getDb()` directo en components.** Siempre via repos:

```ts
import { itemsRepo } from '@/lib/db/repositories/itemsRepo';

const items = await itemsRepo.listByTenant(tenantId, { soloVisiblesPos: true });
```

Cuando agregues una operación nueva (ej. `marcarAgotadoLocal`), agregala al
repo correspondiente, NO desde el component. Los components no saben que la
DB local existe.

## Cómo agregar un campo nuevo a un store existente

1. Actualizar el tipo en `types/database.ts` (o el local equivalente en `schema.ts`).
2. Si requiere migration de IndexedDB (agregar índice, cambiar keyPath):
   - Incrementar `DB_VERSION` en `schema.ts`.
   - Agregar entrada nueva en `MIGRATIONS` array de `migrations.ts`.
   - Tests: agregar caso en `__tests__/` que valide la migration sobre una
     DB vieja (verificar con `runMigrations({ db, oldVersion: N-1, ... })`).
3. Si es solo un campo nuevo en el tipo (sin índice): no requiere migration,
   los rows viejos seguirán sin el campo (undefined) hasta que se updaten.

## Cómo agregar un STORE nuevo

1. Agregar el tipo de la fila a `schema.ts`.
2. Agregar el nombre al array `STORES` (y al type `StoreTypes`).
3. Incrementar `DB_VERSION` + agregar `migrateToV{N}` en `migrations.ts`
   que llama `db.createObjectStore('mi_store', { keyPath: 'id' })` + sus
   índices.
4. Crear `repositories/miStoreRepo.ts` extendiendo `BaseRepository<'mi_store'>`.
5. Crear test en `__tests__/`.

## Patrón Repository

Cada repo extiende `BaseRepository<StoreName>`. Hereda automáticamente:

| Método | Qué hace |
|---|---|
| `getById(id)` | Una fila por PK |
| `getAll()` | Toda la tabla (cuidado con tablas grandes) |
| `count()` | Cantidad de filas |
| `put(row, opts?)` | Insert/update. Sin `opts.skipDirty`, marca dirty |
| `putMany(rows, opts?)` | Bulk insert/update en 1 transaction |
| `delete(id)` | Borra por PK |
| `clear()` | Borra todo el store |
| `findByIndex(idxName, value)` | Query por índice secundario |
| `findDirty()` | Lista filas con `_local_dirty=true` (para sync push) |
| `markSynced(id)` | Limpia el flag dirty (después de push OK) |

Los repos concretos agregan queries específicas del dominio:
- `itemsRepo.listByTenant(tenantId, opts)`
- `mesasRepo.listConVentas(localId)` (join in-memory con ventas abiertas)
- `ventasRepo.findByMesa(mesaId)` (la abierta)
- `ventasItemsRepo.listByVenta(ventaId)`

## Metadata local privada (`_local_*`)

Todos los rows pueden tener estos campos extra. NO se mandan al cloud — el
sync engine (Fase 2) los strippa antes de push:

| Campo | Significado |
|---|---|
| `_local_dirty` | true = cambio sin sincronizar |
| `_local_op` | última operación (`insert` / `update` / `delete`) |
| `_local_synced_at` | timestamp ISO del último push OK |
| `_local_origin` | UUID del device que generó el cambio |

## Cuándo usar `skipDirty: true`

Cuando estás escribiendo en local UNA fila que viene del cloud (pull). Esa
no es una mutación local, es replicación. Si la marcas dirty, el sync engine
intentará pushearla de vuelta al cloud = ping-pong infinito.

```ts
// MAL — esto causa ping-pong si los datos vienen del cloud
await itemsRepo.put(itemDesdeCloud);

// BIEN — pull desde el cloud, no es cambio local
await itemsRepo.put(itemDesdeCloud, { skipDirty: true });

// MAL — replaceForTenant no acepta opts, pero internamente usa skipDirty
// implícito (es pull total). Si necesitás insertar batch con dirty, usá putMany
```

## Reset de DB

`resetDb()` borra TODO el contenido. Llamar en logout para que el próximo
usuario no vea datos del anterior. En tests, el polyfill `fake-indexeddb`
permite resetear con `_resetSingletonForTest()` sin tocar el storage real.

## Tests

```bash
pnpm --filter comanda exec vitest run src/lib/db/
```

Los tests usan `fake-indexeddb` (polyfill in-memory). Cada test arranca con
DB limpia via `beforeEach`.

Pattern obligatorio en cada test file:

```ts
import 'fake-indexeddb/auto';  // top of file, antes de cualquier import del repo
import { resetDb, _resetSingletonForTest } from '../../index';

beforeEach(async () => {
  await resetDb().catch(() => {});
  _resetSingletonForTest();
});
```

## Próximos pasos (Fase 2+)

- **Sync engine bidireccional** (`lib/sync/`) — pull initial, pull incremental, push queue, conflict resolution.
- **Migration UUIDs** (Fase 3) — cuando ventas_pos pase a UUID, el `keyPath: 'id'` sigue igual pero el tipo cambia de `number` a `string`.
- **Operaciones offline reales** (Fase 4) — agregar `abrirVenta`, `agregarItem`, `cobrar` que escriben local + queued para push.
- **Mesh LAN** (Fase 5) — cuando lleguemos, evaluamos si seguir con IndexedDB o saltar a SQLite via Tauri.

Ver [OFFLINE_FIRST_ARQUITECTURA.md](../../../OFFLINE_FIRST_ARQUITECTURA.md) para
el roadmap completo.
