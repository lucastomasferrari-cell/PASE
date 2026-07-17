// POS del local — mundo operativo. Une en una sola pantalla las dos mitades
// del mismo flujo: la credencial del dispositivo (Tablet) y los PIN de cada
// empleado (PinPos). La tablet entra una vez con la cuenta del local; después
// cada uno se identifica con su PIN.

import { Tablet as TabletIcon, KeyRound } from 'lucide-react';
import { Tablet } from './Tablet';
import { PinPos } from './PinPos';

interface Props {
  localId: number | null;
  locales: { id: number; nombre: string }[];
}

function SeccionTitulo({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-brand-400">{icon}</span>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-dim-300">{children}</h2>
      <div className="flex-1 h-px bg-ink/10" />
    </div>
  );
}

export function PosLocal({ localId, locales }: Props) {
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">02 //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">POS del local</h1>
      </div>
      <section>
        <SeccionTitulo icon={<TabletIcon className="h-4 w-4" />}>Dispositivos del local</SeccionTitulo>
        <Tablet localId={localId} locales={locales} />
      </section>

      <section>
        <SeccionTitulo icon={<KeyRound className="h-4 w-4" />}>Empleados con PIN</SeccionTitulo>
        <PinPos localId={localId} locales={locales} />
      </section>
    </div>
  );
}
