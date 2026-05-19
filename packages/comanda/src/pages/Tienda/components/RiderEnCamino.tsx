// RiderEnCamino — mini-mapa público que muestra dónde está la moto.
//
// Se monta solo cuando ya verificamos que:
//   - el pedido es delivery
//   - está en estado enviada / lista
//   - hay un rider asignado + online + last_seen reciente (lógica server-side
//     en fn_get_rider_position_publico)
//
// Si la posición es "stale" (>5min), el server no la devuelve y este
// componente no se monta. Por lo tanto siempre que aparezca, la posición
// es "fresca".

import { MapContainer, TileLayer, Marker, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RiderPositionPublica } from '@/services/ridersService';

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export function RiderEnCamino({ rider }: { rider: RiderPositionPublica }) {
  const motoIcon = L.divIcon({
    html: `
      <div style="
        background:#0ea5e9;color:white;font-size:18px;font-weight:700;
        width:36px;height:36px;border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
        border:3px solid white;
      ">🛵</div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    className: '',
  });

  const lastSeenAgoMs = Date.now() - new Date(rider.rider_last_seen_at).getTime();
  const lastSeenAgo = lastSeenAgoMs < 60_000
    ? 'ahora'
    : `hace ${Math.floor(lastSeenAgoMs / 60_000)}min`;

  return (
    <div className="rounded-xl overflow-hidden border border-gray-200 bg-white">
      <div className="p-3 bg-sky-50 border-b border-sky-100 flex items-center gap-2 text-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        <span className="font-medium">{rider.rider_nombre}</span>
        <span className="text-foreground/60 text-xs ml-auto">Última posición: {lastSeenAgo}</span>
      </div>
      <div style={{ height: 240, width: '100%' }}>
        <MapContainer
          center={[rider.rider_lat, rider.rider_lon]}
          zoom={15}
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom={false}
          dragging={true}
          touchZoom={true}
          doubleClickZoom={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            url={TILE_URL}
          />
          <Marker position={[rider.rider_lat, rider.rider_lon]} icon={motoIcon}>
            <Tooltip direction="top" offset={[0, -18]} permanent>
              <span style={{ fontSize: 11, fontWeight: 600 }}>{rider.rider_nombre}</span>
            </Tooltip>
          </Marker>
        </MapContainer>
      </div>
      <div className="p-3 text-xs text-foreground/60 text-center">
        Posición aproximada · actualiza cada 15 segundos
      </div>
    </div>
  );
}
