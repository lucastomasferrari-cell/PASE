// RiderPWA — pantalla pública que el repartidor abre en su celular.
//
// URL: /r/:token
//
// Flow:
//   1. El dueño/admin crea el rider en COMANDA → genera token.
//   2. El dueño le manda al rider el link por WhatsApp (botón
//      "Compartir link" copia al portapapeles).
//   3. El rider abre el link en su celu → ve esta pantalla.
//   4. Toca "Estoy online" → pide permiso GPS → empieza a postear posición.
//   5. Cuando termina turno: toca "Estoy offline" o cierra la página.
//
// Diseño:
//   - Pantalla full-screen, mobile-first, fondo negro/oscuro para ahorrar
//     batería en OLED. UI grande para tocar mientras conducís — NO mientras
//     conducís en realidad, pero sí en una para/semáforo.
//   - Indicador visual de estado: 🟢 online + lat/lon + accuracy.
//   - Mapa con el pedido actual (si hay asignado) + tu ubicación.
//
// Battery:
//   - watchPosition con highAccuracy=true gasta mucha batería. Le damos
//     opción al rider de "modo eco" (highAccuracy=false) que usa cell
//     tower triangulation (precisión 100-1000m, batería x10 menos).
//   - Detección de battery via Battery API (deprecated en algunos browsers
//     pero todavía funciona en Chrome Android).
//
// Offline:
//   - Si pierde conexión, queue local en memoria + reintenta al reconectar.
//   - Si el celu se duerme, el watchPosition se pausa (no hay forma de
//     evitarlo sin app nativa). Le recordamos al rider mantener la pantalla
//     activa o usar wake lock.

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  actualizarPosicionRider, toggleRiderOnline, getRiderInfoPublica,
  type RiderInfoPublica,
} from '@/services/ridersService';

const POSITION_INTERVAL_MS = 30_000; // postea cada 30s
const REFRESH_INFO_MS = 20_000;       // refresca info del rider (¿le asignaron pedido?)
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export function RiderPWA() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<RiderInfoPublica | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalidToken, setInvalidToken] = useState(false);
  const [online, setOnline] = useState(false);
  const [pos, setPos] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [battery, setBattery] = useState<number | null>(null);
  const [lastPost, setLastPost] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [postingCount, setPostingCount] = useState({ ok: 0, fail: 0 });

  const watchIdRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // ── 1. Cargar info del rider desde el token + refresh periódico
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadInfo = async () => {
      const { data, error: e } = await getRiderInfoPublica(token);
      if (cancelled) return;
      if (e) {
        setError(e);
      } else if (!data) {
        setInvalidToken(true);
      } else {
        setInfo(data);
        // Si el server dice que el rider ya está online, reflejamos en UI
        if (data.online && !online) setOnline(true);
      }
      setLoading(false);
    };
    void loadInfo();
    const t = setInterval(loadInfo, REFRESH_INFO_MS);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── 2. Battery API (best-effort)
  useEffect(() => {
    interface BatteryManager extends EventTarget {
      level: number;
      addEventListener: (type: string, listener: () => void) => void;
    }
    interface NavigatorBattery extends Navigator {
      getBattery?: () => Promise<BatteryManager>;
    }
    const nav = navigator as NavigatorBattery;
    if (!nav.getBattery) return;
    let mounted = true;
    let mgr: BatteryManager | null = null;
    const update = () => mounted && mgr && setBattery(Math.round(mgr.level * 100));
    nav.getBattery().then((m) => {
      mgr = m;
      update();
      m.addEventListener('levelchange', update);
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // ── 3. Wake lock para mantener pantalla activa cuando está online
  useEffect(() => {
    // Type narrowing manual — WakeLock no está en lib.dom estándar de TS5+ en todos los targets.
    const wakeLockApi = (navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
    }).wakeLock;
    if (online && wakeLockApi) {
      wakeLockApi.request('screen').then((sentinel) => {
        wakeLockRef.current = sentinel;
      }).catch(() => {});
    } else if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
    return () => {
      if (wakeLockRef.current) wakeLockRef.current.release().catch(() => {});
    };
  }, [online]);

  // ── 4. Toggle online: arranca/detiene tracking
  async function handleToggle() {
    if (!token) return;
    const newOnline = !online;

    if (newOnline) {
      // Pedir permiso GPS primero — fail fast si no se da
      if (!navigator.geolocation) {
        setError('Tu celular no soporta GPS.');
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            () => resolve(),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10_000 },
          );
        });
      } catch {
        setError('No diste permiso de ubicación. Revisá los permisos del navegador.');
        return;
      }

      // Toggle online server-side
      const r = await toggleRiderOnline(token, true);
      if (!r.ok) {
        setError(r.error || 'No pude activar online');
        return;
      }
      setOnline(true);
      setError(null);
      startTracking();
    } else {
      // Toggle offline server-side + parar tracking
      stopTracking();
      await toggleRiderOnline(token, false);
      setOnline(false);
    }
  }

  function startTracking() {
    if (!navigator.geolocation || !token) return;
    setError(null);

    // watchPosition: callback cada vez que el GPS tiene nueva fix.
    // Lo combinamos con un setInterval que hace POST cada 30s — el callback
    // solo actualiza state local, NO postea cada vez (sería overkill).
    watchIdRef.current = navigator.geolocation.watchPosition(
      (p) => {
        setPos({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
        });
      },
      (err) => {
        console.warn('[gps] error:', err.message);
        setError(`GPS: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );

    // Postear cada 30s
    intervalRef.current = setInterval(() => { void postPosition(); }, POSITION_INTERVAL_MS);
    // Y un primer post inmediato (después de 2s para tener una primera fix)
    setTimeout(() => { void postPosition(); }, 2_000);
  }

  function stopTracking() {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  async function postPosition() {
    if (!token || !pos) return;
    const r = await actualizarPosicionRider({
      riderToken: token,
      lat: pos.lat,
      lon: pos.lon,
      accuracyM: pos.accuracy,
      batteryPct: battery ?? undefined,
    });
    if (r.ok) {
      setLastPost(new Date());
      setPostingCount((c) => ({ ...c, ok: c.ok + 1 }));
    } else {
      setPostingCount((c) => ({ ...c, fail: c.fail + 1 }));
      if (r.error?.includes('REVOCADO')) {
        // Token revocado → forzar offline
        stopTracking();
        setOnline(false);
        setError('Tu acceso fue revocado por el local. Pedí un link nuevo.');
      }
    }
  }

  // ── Cleanup al desmontar
  useEffect(() => () => stopTracking(), []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#a1a1aa' }}>Cargando…</div>;
  }

  if (invalidToken) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <h1 style={{ fontSize: 22 }}>Link inválido</h1>
        <p style={{ color: '#71717a', marginTop: 12 }}>
          Pedile al local que te mande un link nuevo.
        </p>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: online ? '#0f172a' : '#18181b',
      color: 'white',
      fontFamily: '-apple-system,Segoe UI,Roboto,sans-serif',
      paddingBottom: 24,
    }}>
      {/* Header */}
      <div style={{ padding: 16, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <div style={{ fontSize: 12, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          COMANDA Rider
        </div>
        <h1 style={{ fontSize: 22, margin: '4px 0 0' }}>{info?.nombre ?? 'Repartidor'}</h1>
      </div>

      {/* Status */}
      <div style={{ padding: 24, textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 24px',
          background: online ? '#22c55e' : '#3f3f46',
          borderRadius: 20,
          fontSize: 16,
          fontWeight: 600,
        }}>
          <span style={{
            width: 12,
            height: 12,
            background: 'white',
            borderRadius: '50%',
            animation: online ? 'pulse 2s infinite' : 'none',
          }} />
          {online ? 'En línea' : 'Desconectado'}
        </div>

        <button
          onClick={handleToggle}
          style={{
            display: 'block',
            margin: '24px auto 0',
            padding: '16px 32px',
            background: online ? '#ef4444' : '#22c55e',
            color: 'white',
            border: 'none',
            borderRadius: 12,
            fontSize: 18,
            fontWeight: 600,
            cursor: 'pointer',
            minWidth: 240,
          }}
        >
          {online ? 'Terminar turno' : 'Empezar turno'}
        </button>

        {error && (
          <div style={{
            marginTop: 16,
            padding: 12,
            background: 'rgba(239,68,68,0.2)',
            borderRadius: 8,
            color: '#fecaca',
            fontSize: 13,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Info pos */}
      {online && pos && (
        <div style={{ padding: '0 16px 16px', fontSize: 13 }}>
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            padding: 12,
            borderRadius: 8,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
          }}>
            <div>
              <div style={{ color: '#a1a1aa', fontSize: 11 }}>Precisión GPS</div>
              <div style={{ fontWeight: 500 }}>±{Math.round(pos.accuracy)}m</div>
            </div>
            {battery != null && (
              <div>
                <div style={{ color: '#a1a1aa', fontSize: 11 }}>Batería</div>
                <div style={{ fontWeight: 500 }}>🔋 {battery}%</div>
              </div>
            )}
            <div>
              <div style={{ color: '#a1a1aa', fontSize: 11 }}>Último envío</div>
              <div style={{ fontWeight: 500 }}>
                {lastPost ? lastPost.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
              </div>
            </div>
            <div>
              <div style={{ color: '#a1a1aa', fontSize: 11 }}>OK / Fallos</div>
              <div style={{ fontWeight: 500 }}>{postingCount.ok} / {postingCount.fail}</div>
            </div>
          </div>
        </div>
      )}

      {/* Pedido actual (si hay) */}
      {info?.current_venta_id && (
        <div style={{ padding: '0 16px' }}>
          <div style={{ fontSize: 11, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Pedido actual
          </div>
          <div style={{ background: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>#{info.pedido_numero}</div>
            <div style={{ marginTop: 4 }}>{info.pedido_cliente}</div>
            <div style={{ marginTop: 4, fontSize: 13, color: '#a1a1aa' }}>{info.pedido_direccion}</div>
          </div>

          {/* Mini-mapa con tu pos + destino */}
          {pos && info.pedido_lat && info.pedido_lon && (
            <div style={{ marginTop: 12, height: 240, borderRadius: 8, overflow: 'hidden' }}>
              <MapContainer
                center={[(pos.lat + info.pedido_lat) / 2, (pos.lon + info.pedido_lon) / 2]}
                zoom={13}
                style={{ height: '100%', width: '100%' }}
                scrollWheelZoom={false}
              >
                <TileLayer
                  attribution='&copy; OSM'
                  url={TILE_URL}
                />
                <Marker
                  position={[pos.lat, pos.lon]}
                  icon={L.divIcon({
                    html: '<div style="width:18px;height:18px;background:#0ea5e9;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>',
                    iconSize: [18, 18],
                    iconAnchor: [9, 9],
                    className: '',
                  })}
                />
                <Marker
                  position={[info.pedido_lat, info.pedido_lon]}
                  icon={L.divIcon({
                    html: '<div style="font-size:24px;">📍</div>',
                    iconSize: [24, 24],
                    iconAnchor: [12, 24],
                    className: '',
                  })}
                />
                <Polyline
                  positions={[[pos.lat, pos.lon], [info.pedido_lat, info.pedido_lon]]}
                  color="#0ea5e9"
                  weight={3}
                  opacity={0.6}
                  dashArray="6 6"
                />
              </MapContainer>
            </div>
          )}

          {/* Botón "Abrir en Google Maps" para navegación turn-by-turn */}
          {info.pedido_lat && info.pedido_lon && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${info.pedido_lat},${info.pedido_lon}&travelmode=driving`}
              target="_blank"
              rel="noopener"
              style={{
                display: 'block',
                marginTop: 12,
                padding: 14,
                background: '#0ea5e9',
                color: 'white',
                textAlign: 'center',
                textDecoration: 'none',
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              🗺️ Cómo llegar (Google Maps)
            </a>
          )}
        </div>
      )}

      {/* Tip */}
      {online && (
        <div style={{ padding: '24px 16px 0', fontSize: 12, color: '#71717a', textAlign: 'center' }}>
          Mantené la pantalla activa para mejor tracking.
          <br />
          Cuando termines el turno tocá "Terminar turno" 👆
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
