// Confirmación post-pago — /r/confirmacion/:tipo/:id.
// MercadoPago devuelve acá tras el checkout. El webhook confirma del lado del
// servidor; esta página POLLEA el estado hasta verlo pagado (o se cansa y
// muestra "estamos confirmando"). Para giftcards muestra el CÓDIGO.

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Clock3, Gift, CalendarCheck } from 'lucide-react';
import { supabaseConfigurado } from '@/lib/supabase';
import { getEstadoPago, type EstadoPago } from '@/lib/perfilService';

const fmtARS = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

export function Confirmacion() {
  const { tipo, id } = useParams<{ tipo: string; id: string }>();
  const [pago, setPago] = useState<EstadoPago | null>(null);
  const [agotado, setAgotado] = useState(false);
  const intentos = useRef(0);

  const tipoOk = tipo === 'evento' || tipo === 'gift';
  const idNum = Number(id);

  useEffect(() => {
    if (!supabaseConfigurado || !tipoOk || !idNum) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancel = false;

    async function poll() {
      const r = await getEstadoPago(tipo as 'evento' | 'gift', idNum);
      if (cancel) return;
      if (r) setPago(r);
      const pagado = r && r.estado !== 'pendiente_pago';
      intentos.current += 1;
      if (!pagado && intentos.current < 15) {
        timer = setTimeout(() => void poll(), 2500);   // ~37s de polling
      } else if (!pagado) {
        setAgotado(true);
      }
    }
    void poll();
    return () => { cancel = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipo, idNum]);

  if (!tipoOk || !idNum) {
    return <Centro><p className="font-display text-2xl">Link inválido</p></Centro>;
  }
  if (!pago) {
    return (
      <Centro>
        <Clock3 className="h-10 w-10 text-brand-400 mx-auto animate-pulse" />
        <p className="mt-3 font-display text-2xl">Confirmando tu pago…</p>
        <p className="mt-1 text-sm text-ink-muted">Unos segundos, no cierres esta página.</p>
      </Centro>
    );
  }

  const pagado = pago.estado !== 'pendiente_pago';

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl bg-white border border-ink/5 shadow-sm p-8 text-center">
        {pagado ? (
          <CheckCircle2 className="h-12 w-12 text-green-600 mx-auto" />
        ) : (
          <Clock3 className="h-12 w-12 text-amber-500 mx-auto" />
        )}
        <p className="mt-4 font-display text-2xl font-semibold">
          {pagado ? '¡Pago confirmado!' : agotado ? 'Estamos confirmando tu pago' : 'Confirmando…'}
        </p>

        <div className="mt-4 rounded-xl bg-crema p-4 text-sm text-left space-y-1.5">
          <p className="flex items-center gap-2 font-medium">
            {tipo === 'gift' ? <Gift className="h-4 w-4 text-brand-500" /> : <CalendarCheck className="h-4 w-4 text-brand-500" />}
            {pago.titulo}
          </p>
          {tipo === 'evento' && pago.cantidad != null && (
            <p className="text-ink-soft">{pago.cantidad} {pago.cantidad === 1 ? 'cupo' : 'cupos'}{pago.fecha ? ` · ${new Date(pago.fecha).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` : ''}</p>
          )}
          {tipo === 'gift' && pago.para && <p className="text-ink-soft">Para {pago.para}</p>}
          <p className="text-ink-soft">{fmtARS(Number(pago.monto))}</p>
        </div>

        {tipo === 'gift' && pagado && pago.codigo && (
          <div className="mt-4 rounded-xl border-2 border-dashed border-brand-300 bg-brand-50 p-4">
            <p className="text-xs text-ink-muted">Código de la giftcard — guardalo, se presenta en el local:</p>
            <p className="mt-1 font-mono text-2xl font-semibold tracking-wider text-brand-700">{pago.codigo}</p>
          </div>
        )}

        {!pagado && agotado && (
          <p className="mt-4 text-xs text-ink-muted">
            MercadoPago a veces tarda unos minutos. Refrescá esta página en un
            rato — tu lugar/compra quedó registrada con el pago en proceso.
          </p>
        )}

        <Link to="/" className="mt-6 inline-block text-sm text-brand-600 hover:underline">
          ← Volver
        </Link>
      </div>
    </div>
  );
}

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center text-center px-6"><div>{children}</div></div>;
}
