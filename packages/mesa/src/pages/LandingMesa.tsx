// Landing del producto MESA. Placeholder con identidad — el contenido de
// venta real se escribe cuando el producto esté operando con Neko.

import { Link } from 'react-router-dom';
import { CalendarCheck, Zap, Gift, Users } from 'lucide-react';

export function LandingMesa() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="container flex items-center justify-between py-6">
        <span className="font-display text-2xl font-semibold text-brand-600">mesa.</span>
        <Link to="/admin" className="text-sm text-ink-soft hover:text-ink underline-offset-4 hover:underline">
          Acceso restaurantes
        </Link>
      </header>

      <main className="container flex-1 flex flex-col justify-center py-16">
        <h1 className="font-display text-4xl sm:text-6xl font-semibold leading-tight max-w-2xl">
          Reservas que hablan con tu salón.
        </h1>
        <p className="mt-5 text-lg text-ink-soft max-w-xl">
          MESA sabe qué mesas están ocupadas <em>ahora</em> porque vive conectado
          a tu punto de venta. Reservas, eventos con prepago y giftcards — sin
          comisión por cubierto.
        </p>
        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-3xl">
          {[
            { icon: Zap, t: '¿Hay mesa ahora?', d: 'Disponibilidad real leyendo el POS en vivo.' },
            { icon: CalendarCheck, t: 'Eventos con prepago', d: 'El cupo se paga al reservar. Chau no-shows.' },
            { icon: Gift, t: 'Giftcards', d: 'Se venden online, se canjean en el salón.' },
            { icon: Users, t: 'Conocé a tu cliente', d: 'Perfil con consumo real de cada visita.' },
          ].map(({ icon: Icon, t, d }) => (
            <div key={t} className="rounded-xl bg-white p-4 shadow-card border border-ink/5">
              <Icon className="h-5 w-5 text-brand-500" />
              <p className="mt-2 font-medium">{t}</p>
              <p className="mt-1 text-sm text-ink-muted">{d}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="container py-6 text-xs text-ink-muted">
        mesa. — parte del ecosistema PASE · COMANDA · MESA
      </footer>
    </div>
  );
}
