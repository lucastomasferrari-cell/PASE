import { useEffect, useState } from 'react';
import type { VentaPosItem } from '../../../types/database';
import { listVentaOverrides, type VentaOverrideHistoria } from '../../../services/overridesService';

export interface UseVentaOverridesResult {
  historial: VentaOverrideHistoria[];
  historialOpen: boolean;
  setHistorialOpen: React.Dispatch<React.SetStateAction<boolean>>;
  anularItemTarget: VentaPosItem | null;
  setAnularItemTarget: React.Dispatch<React.SetStateAction<VentaPosItem | null>>;
  cortesiaItemTarget: VentaPosItem | null;
  setCortesiaItemTarget: React.Dispatch<React.SetStateAction<VentaPosItem | null>>;
  precioItemTarget: VentaPosItem | null;
  setPrecioItemTarget: React.Dispatch<React.SetStateAction<VentaPosItem | null>>;
  precioNuevo: number;
  setPrecioNuevo: React.Dispatch<React.SetStateAction<number>>;
  precioMotivo: string;
  setPrecioMotivo: React.Dispatch<React.SetStateAction<string>>;
  showPrecioMgr: boolean;
  setShowPrecioMgr: React.Dispatch<React.SetStateAction<boolean>>;
  loadHistorial: () => Promise<void>;
}

export function useVentaOverrides(ventaId: number): UseVentaOverridesResult {
  const [historial, setHistorial] = useState<VentaOverrideHistoria[]>([]);
  const [historialOpen, setHistorialOpen] = useState(false);

  const [anularItemTarget, setAnularItemTarget] = useState<VentaPosItem | null>(null);
  const [cortesiaItemTarget, setCortesiaItemTarget] = useState<VentaPosItem | null>(null);
  const [precioItemTarget, setPrecioItemTarget] = useState<VentaPosItem | null>(null);
  const [precioNuevo, setPrecioNuevo] = useState<number>(0);
  const [precioMotivo, setPrecioMotivo] = useState('');
  const [showPrecioMgr, setShowPrecioMgr] = useState(false);

  // Cargar historial cuando se abre
  useEffect(() => {
    if (!historialOpen || !Number.isFinite(ventaId)) return;
    listVentaOverrides(ventaId).then((r) => setHistorial(r.data));
  }, [historialOpen, ventaId]);

  async function loadHistorial(): Promise<void> {
    if (!Number.isFinite(ventaId)) return;
    const r = await listVentaOverrides(ventaId);
    setHistorial(r.data);
  }

  return {
    historial,
    historialOpen,
    setHistorialOpen,
    anularItemTarget,
    setAnularItemTarget,
    cortesiaItemTarget,
    setCortesiaItemTarget,
    precioItemTarget,
    setPrecioItemTarget,
    precioNuevo,
    setPrecioNuevo,
    precioMotivo,
    setPrecioMotivo,
    showPrecioMgr,
    setShowPrecioMgr,
    loadHistorial,
  };
}
