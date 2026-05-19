// DeliveryMap — wrapper de Leaflet/OSM con markers de pedidos + riders.
//
// Uso:
//   <DeliveryMap
//     center={[localLat, localLon]}
//     pedidos={pedidos}
//     riders={riders}
//     onPedidoClick={(id) => ...}
//     selectedPedidoId={123}
//   />
//
// Tiles: OpenStreetMap (gratis, sin API key, tier free unlimited). Para
// volumen grande considerar Mapbox o caching propio. Para AR alcanza.
//
// Notas técnicas:
//   - react-leaflet@5 con React 19.
//   - Leaflet CSS se importa al tope para que los markers/popups se vean OK.
//   - Iconos por default de Leaflet vienen rotos en bundlers — usamos
//     divIcon con HTML para evitar el problema.

import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { PedidoDeliveryMapa, Rider } from '@/services/ridersService';

// ─── Iconos custom (divIcon) ─────────────────────────────────────────
//
// urgencia: < 20min verde, 20-40 amarillo, > 40 rojo
function urgenciaColor(minutos: number | null): string {
  if (minutos == null) return '#6b7280'; // gray
  if (minutos < 20) return '#22c55e';     // green-500
  if (minutos < 40) return '#f59e0b';     // amber-500
  return '#ef4444';                       // red-500
}

function buildPedidoIcon(numero: number, minutos: number | null, selected: boolean): L.DivIcon {
  const color = urgenciaColor(minutos);
  const minStr = minutos != null ? `${Math.floor(minutos)}min` : '—';
  const scale = selected ? 1.15 : 1;
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;transform:scale(${scale});transform-origin:bottom center;">
        <div style="
          background:${color};color:white;font-size:11px;font-weight:600;
          padding:3px 8px;border-radius:8px;white-space:nowrap;
          box-shadow:0 2px 6px rgba(0,0,0,0.2);
          border:${selected ? '2px solid #18181b' : '2px solid white'};
          margin-bottom:4px;
        ">#${numero} · ${minStr}</div>
        <div style="
          width:0;height:0;
          border-left:6px solid transparent;
          border-right:6px solid transparent;
          border-top:8px solid ${color};
          margin:0 auto;
        "></div>
      </div>
    `,
    iconSize: [60, 40],
    iconAnchor: [30, 40],
  });
}

function buildRiderIcon(nombre: string, online: boolean): L.DivIcon {
  const color = online ? '#0ea5e9' : '#a1a1aa';
  const initial = nombre.trim().charAt(0).toUpperCase() || '?';
  return L.divIcon({
    className: '',
    html: `
      <div style="
        background:${color};color:white;font-size:14px;font-weight:700;
        width:32px;height:32px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 6px rgba(0,0,0,0.3);
        border:2px solid white;
      ">${initial}</div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

// ─── Helper: re-centrar mapa cuando cambia center ────────────────────
function RecenterOnChange({ center, zoom }: { center: [number, number]; zoom?: number }) {
  const map = useMap();
  const prev = useRef<[number, number] | null>(null);
  useEffect(() => {
    if (!prev.current || prev.current[0] !== center[0] || prev.current[1] !== center[1]) {
      map.setView(center, zoom ?? map.getZoom(), { animate: true });
      prev.current = center;
    }
  }, [center, zoom, map]);
  return null;
}

export interface DeliveryMapProps {
  center: [number, number];
  zoom?: number;
  pedidos?: PedidoDeliveryMapa[];
  riders?: Rider[];
  selectedPedidoId?: number | null;
  onPedidoClick?: (ventaId: number) => void;
  onRiderClick?: (riderId: number) => void;
  /** Altura del mapa. Default 'calc(100vh - 220px)'. */
  height?: string;
}

export function DeliveryMap({
  center,
  zoom = 14,
  pedidos = [],
  riders = [],
  selectedPedidoId,
  onPedidoClick,
  onRiderClick,
  height = 'calc(100vh - 220px)',
}: DeliveryMapProps) {
  // Filtrar items sin coords (no se pueden mapear)
  const pedidosConCoords = useMemo(
    () => pedidos.filter((p) => p.cliente_lat != null && p.cliente_lon != null),
    [pedidos],
  );
  const ridersConCoords = useMemo(
    () => riders.filter((r) => r.last_lat != null && r.last_lon != null && r.online),
    [riders],
  );

  return (
    <div style={{ height, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid #e4e4e7' }}>
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom
      >
        <RecenterOnChange center={center} zoom={zoom} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {pedidosConCoords.map((p) => (
          <Marker
            key={`p-${p.venta_id}`}
            position={[p.cliente_lat!, p.cliente_lon!]}
            icon={buildPedidoIcon(p.numero_local, p.minutos_desde_enviada, p.venta_id === selectedPedidoId)}
            eventHandlers={{
              click: () => onPedidoClick?.(p.venta_id),
            }}
          >
            <Tooltip direction="top" offset={[0, -42]} opacity={0.95}>
              <div style={{ fontSize: 12 }}>
                <strong>#{p.numero_local}</strong> · {p.cliente_nombre ?? 'cliente'}
                <br />
                {p.cliente_direccion ?? ''}
                {p.rider_nombre && <><br /><em>moto: {p.rider_nombre}</em></>}
              </div>
            </Tooltip>
          </Marker>
        ))}

        {ridersConCoords.map((r) => (
          <Marker
            key={`r-${r.id}`}
            position={[r.last_lat!, r.last_lon!]}
            icon={buildRiderIcon(r.nombre, r.online)}
            eventHandlers={{
              click: () => onRiderClick?.(r.id),
            }}
          >
            <Popup>
              <div style={{ fontSize: 12 }}>
                <strong>{r.nombre}</strong>
                <br />
                {r.status === 'en_linea' ? '🟢 en línea' : '⚪ desconectado'}
                {r.current_venta_id && <><br />Entregando #{r.pedido_numero}</>}
                {r.last_battery_pct != null && <><br />🔋 {r.last_battery_pct}%</>}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
