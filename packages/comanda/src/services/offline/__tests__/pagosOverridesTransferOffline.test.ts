// Tests E2E mutantes de los servicios offline de Fase 4.4:
//   - pagosOfflineService.cobrarVentaOffline
//   - overridesOfflineService.{anular,cortesia,modificarPrecio,descuento,anularVenta}
//   - transferenciasOfflineService.{transferir,unir,partir}

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cobrarVentaOffline } from '../pagosOfflineService';
import {
  anularItemOffline, cortesiaItemOffline, modificarPrecioItemOffline,
  aplicarDescuentoOffline, anularVentaOffline,
} from '../overridesOfflineService';
import {
  transferirMesaOffline, unirMesasOffline, partirCuentaOffline,
} from '../transferenciasOfflineService';
import { abrirVentaOffline, agregarItemOffline } from '../ventasOfflineService';
import { ventasRepo, ventasItemsRepo, ventasPagosRepo } from '@/lib/db/repositories/ventasRepo';
import { listPendingOps } from '@/lib/sync/operations';
import { resetDb, _resetSingletonForTest } from '@/lib/db/index';
import { syncEngine } from '@/lib/sync/syncEngine';

vi.spyOn(syncEngine, 'triggerPush').mockImplementation(async () => {});

async function setupVentaConItems() {
  const { tempVentaId } = await abrirVentaOffline({
    tenantId: 'T', localId: 1, canalId: 2, modo: 'salon',
  });
  const itemA = await agregarItemOffline({
    ventaId: tempVentaId, itemId: 100, cantidad: 2,
    precioUnitario: 500, tenantId: 'T', localId: 1,
  });
  const itemB = await agregarItemOffline({
    ventaId: tempVentaId, itemId: 200, cantidad: 1,
    precioUnitario: 800, tenantId: 'T', localId: 1,
  });
  return { tempVentaId, itemA: itemA.tempItemId, itemB: itemB.tempItemId };
}

describe('pagosOfflineService', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('cobrarVentaOffline: crea pagos local, marca venta cobrada, encola RPC', async () => {
    const { tempVentaId } = await setupVentaConItems();
    const res = await cobrarVentaOffline({
      ventaId: tempVentaId,
      pagos: [{ metodo: 'efectivo', monto: 1800 }],
      tenantId: 'T', localId: 1,
    });
    expect(res.tempPagoIds).toHaveLength(1);
    const v = await ventasRepo.getById(tempVentaId);
    expect(v?.estado).toBe('cobrada');
    expect((v as unknown as { pagada: boolean }).pagada).toBe(true);
    const pagos = await ventasPagosRepo.listByVenta(tempVentaId);
    expect(pagos).toHaveLength(1);
    expect(pagos[0]!.metodo).toBe('efectivo');
    const ops = await listPendingOps();
    expect(ops.some((o) => o.target === 'fn_cobrar_venta_comanda')).toBe(true);
  });

  it('cobrarVentaOffline split: efectivo + tarjeta crea 2 pagos rows', async () => {
    const { tempVentaId } = await setupVentaConItems();
    const res = await cobrarVentaOffline({
      ventaId: tempVentaId,
      pagos: [
        { metodo: 'efectivo', monto: 1000 },
        { metodo: 'tarjeta-debito', monto: 800 },
      ],
      tenantId: 'T', localId: 1,
    });
    expect(res.tempPagoIds).toHaveLength(2);
    const pagos = await ventasPagosRepo.listByVenta(tempVentaId);
    expect(pagos).toHaveLength(2);
    expect(pagos.map((p) => p.metodo).sort()).toEqual(['efectivo', 'tarjeta-debito']);
  });
});

describe('overridesOfflineService', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('anularItemOffline: marca item anulado + resta del total venta', async () => {
    const { tempVentaId, itemA } = await setupVentaConItems();
    const vAntes = await ventasRepo.getById(tempVentaId);
    const totalAntes = Number(vAntes?.total ?? 0);
    await anularItemOffline({ itemId: itemA, managerId: 'mgr', motivo: 'cliente reclamó' });
    const item = await ventasItemsRepo.getById(itemA);
    expect(item?.estado).toBe('anulado');
    const vDespues = await ventasRepo.getById(tempVentaId);
    expect(Number(vDespues?.total)).toBe(totalAntes - 1000); // item era 2×500
  });

  it('cortesiaItemOffline: precio→0, es_cortesia=true, resta del total', async () => {
    const { tempVentaId, itemB } = await setupVentaConItems();
    const vAntes = await ventasRepo.getById(tempVentaId);
    const totalAntes = Number(vAntes?.total ?? 0);
    await cortesiaItemOffline({ itemId: itemB, managerId: 'mgr', motivo: 'cumpleaños' });
    const item = await ventasItemsRepo.getById(itemB);
    expect((item as unknown as { es_cortesia: boolean }).es_cortesia).toBe(true);
    expect(Number(item?.precio_unitario)).toBe(0);
    expect(Number(item?.subtotal)).toBe(0);
    const vDespues = await ventasRepo.getById(tempVentaId);
    expect(Number(vDespues?.total)).toBe(totalAntes - 800); // item B era 800
  });

  it('modificarPrecioItemOffline: cambia precio + recalcula subtotal y total venta', async () => {
    const { tempVentaId, itemA } = await setupVentaConItems();
    // itemA era 2×500=1000. Bajar precio a 300 → subtotal=600.
    await modificarPrecioItemOffline({
      itemId: itemA, precioNuevo: 300, managerId: 'mgr', motivo: 'descuento amigo',
    });
    const item = await ventasItemsRepo.getById(itemA);
    expect(Number(item?.precio_unitario)).toBe(300);
    expect(Number(item?.subtotal)).toBe(600);
    expect((item as unknown as { precio_unitario_original: number }).precio_unitario_original).toBe(500);
    const v = await ventasRepo.getById(tempVentaId);
    // total inicial 1800 (1000+800), nuevo total 600+800=1400
    expect(Number(v?.total)).toBe(1400);
  });

  it('aplicarDescuentoOffline: suma al descuento_total + resta total', async () => {
    const { tempVentaId } = await setupVentaConItems();
    await aplicarDescuentoOffline({
      ventaId: tempVentaId, monto: 200, motivo: 'cupón', managerId: 'mgr',
    });
    const v = await ventasRepo.getById(tempVentaId);
    expect(Number(v?.descuento_total)).toBe(200);
    expect(Number(v?.total)).toBe(1600); // 1800 - 200
  });

  it('anularVentaOffline: marca estado=anulada + encola RPC', async () => {
    const { tempVentaId } = await setupVentaConItems();
    await anularVentaOffline({
      ventaId: tempVentaId, managerId: 'mgr', motivo: 'cliente se fue',
    });
    const v = await ventasRepo.getById(tempVentaId);
    expect(v?.estado).toBe('anulada');
    const ops = await listPendingOps();
    expect(ops.some((o) => o.target === 'fn_anular_venta_comanda')).toBe(true);
  });
});

describe('transferenciasOfflineService', () => {
  beforeEach(async () => {
    await resetDb().catch(() => {});
    _resetSingletonForTest();
  });

  it('transferirMesaOffline cambia mesa_id local + encola RPC con manager/motivo', async () => {
    const { tempVentaId } = await setupVentaConItems();
    await transferirMesaOffline({
      ventaId: tempVentaId, mesaDestinoId: 99, managerId: 'mgr-uuid', motivo: 'cliente pidió mudarse',
    });
    const v = await ventasRepo.getById(tempVentaId);
    expect(v?.mesa_id).toBe(99);
    const ops = await listPendingOps();
    const op = ops.find((o) => o.target === 'fn_transferir_mesa_comanda');
    expect(op).toBeDefined();
    // Bug 11-jun: la capa offline descartaba manager/motivo y la RPC interna
    // exige manager (MANAGER_REQUERIDO) — ahora viajan en el payload.
    const payload = op?.payload as Record<string, unknown>;
    expect(payload.p_manager_id).toBe('mgr-uuid');
    expect(payload.p_motivo).toBe('cliente pidió mudarse');
  });

  it('unirMesasOffline mueve items destino + cierra origen + suma totales', async () => {
    const { tempVentaId: destino } = await setupVentaConItems(); // total 1800
    const { tempVentaId: origen, itemA: itemAOrigen } = await setupVentaConItems(); // otra venta total 1800
    await unirMesasOffline({
      ventaDestinoId: destino, ventaOrigenId: origen, managerId: 'mgr-uuid', motivo: 'mesas contiguas unidas',
    });
    // Venta destino: ahora tiene items propios + items de origen
    const itemsDestino = await ventasItemsRepo.listByVenta(destino);
    expect(itemsDestino).toHaveLength(4); // 2 originales + 2 de origen
    // El item de origen ahora apunta al destino
    const itemMovido = await ventasItemsRepo.getById(itemAOrigen);
    expect(itemMovido?.venta_id).toBe(destino);
    // Venta origen anulada
    const vOrigen = await ventasRepo.getById(origen);
    expect(vOrigen?.estado).toBe('anulada');
    // Total destino sumado
    const vDestino = await ventasRepo.getById(destino);
    expect(Number(vDestino?.total)).toBe(3600); // 1800 + 1800
  });

  it('partirCuentaOffline: crea venta nueva con items movidos + reduce original', async () => {
    const { tempVentaId, itemA } = await setupVentaConItems(); // total 1800
    const res = await partirCuentaOffline({
      ventaOriginalId: tempVentaId,
      itemsToMove: [itemA], // 2×500=1000
      tenantId: 'T', localId: 1,
      managerId: 'mgr-uuid', motivo: 'cliente paga por separado',
    });
    expect(res.tempVentaNuevaId).toBeLessThan(0);
    // Venta original sin itemA: subtotal y total bajaron 1000
    const vOriginal = await ventasRepo.getById(tempVentaId);
    expect(Number(vOriginal?.total)).toBe(800);
    // Venta nueva con itemA
    const vNueva = await ventasRepo.getById(res.tempVentaNuevaId);
    expect(Number(vNueva?.total)).toBe(1000);
    expect(vNueva?.mesa_id).toBeNull();
    const itemsNueva = await ventasItemsRepo.listByVenta(res.tempVentaNuevaId);
    expect(itemsNueva).toHaveLength(1);
    expect(itemsNueva[0]!.id).toBe(itemA);
    // El item movido apunta a la venta nueva
    const itemMovido = await ventasItemsRepo.getById(itemA);
    expect(itemMovido?.venta_id).toBe(res.tempVentaNuevaId);
  });

  it('partirCuentaOffline encola RPC con reconcile para la venta nueva', async () => {
    const { tempVentaId, itemA } = await setupVentaConItems();
    const res = await partirCuentaOffline({
      ventaOriginalId: tempVentaId,
      itemsToMove: [itemA],
      tenantId: 'T', localId: 1,
      managerId: 'mgr-uuid', motivo: 'cliente paga por separado',
    });
    const ops = await listPendingOps();
    const partirOp = ops.find((o) => o.target === 'fn_partir_cuenta_comanda');
    expect(partirOp).toBeDefined();
    expect(partirOp?.reconcile).toEqual({ kind: 'venta', tempVentaId: res.tempVentaNuevaId });
  });
});
