// La gestión de reservas se migró a la app MESA (mesa-orpin.vercel.app/admin).
// COMANDA conserva el piso del salón del POS (tomar pedidos por mesa) y la
// config de mesas/horarios; la AGENDA de reservas (alta, estados, mapa en vivo,
// lista de espera, comensales, stats) ahora vive en MESA.

import { CalendarHeart, ArrowUpRight, Map, Hourglass, Users, BarChart3 } from 'lucide-react';

const MESA_ADMIN_URL = 'https://mesa-orpin.vercel.app/admin';

const FEATURES = [
  { icon: CalendarHeart, label: 'Agenda del día y alta de reservas' },
  { icon: Map, label: 'Mapa del salón en vivo' },
  { icon: Hourglass, label: 'Lista de espera (walk-ins)' },
  { icon: Users, label: 'Comensales (CRM)' },
  { icon: BarChart3, label: 'Estadísticas de reservas' },
];

export function ReservasMudadas() {
  return (
    <div className="container max-w-2xl py-16">
      <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 text-primary mb-5">
          <CalendarHeart className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Las reservas se mudaron a MESA</h1>
        <p className="mt-2 text-muted-foreground max-w-md mx-auto">
          La gestión de reservas ahora vive en <strong>MESA</strong>, la app de reservas del
          ecosistema. Toda la agenda, el mapa, la lista de espera y los comensales están allá.
        </p>

        <a
          href={MESA_ADMIN_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Abrir reservas en MESA <ArrowUpRight className="h-4 w-4" />
        </a>

        <div className="mt-8 grid sm:grid-cols-2 gap-2 text-left max-w-md mx-auto">
          {FEATURES.map((f) => (
            <div key={f.label} className="flex items-center gap-2 text-sm text-muted-foreground">
              <f.icon className="h-4 w-4 text-primary shrink-0" />
              {f.label}
            </div>
          ))}
        </div>

        <p className="mt-8 text-xs text-muted-foreground border-t border-border pt-5">
          El piso del salón para <strong>tomar pedidos por mesa</strong> sigue en COMANDA (POS → Salón).
          La configuración de mesas y horarios también queda acá (Salón → Mesas / Config. reservas).
        </p>
      </div>
    </div>
  );
}
