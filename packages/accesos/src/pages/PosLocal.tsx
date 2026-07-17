// POS del local — mundo operativo. Une en una sola pantalla las dos mitades
// del mismo flujo: la credencial del dispositivo (Tablet) y los PIN de cada
// empleado (PinPos). La tablet entra una vez con la cuenta del local; después
// cada uno se identifica con su PIN.
//
// Look Command Center (17-jul): sin cajas contenedoras. Cada sección es un
// header horizontal con label mono + count a la derecha + hairline debajo;
// los items viven directo debajo, separados por hairlines.

import { Tablet as TabletIcon, KeyRound } from 'lucide-react';
import { Tablet } from './Tablet';
import { PinPos } from './PinPos';
import { SectionHeader } from '@/components/primitives';

interface Props {
  localId: number | null;
  locales: { id: number; nombre: string }[];
}

export function PosLocal({ localId, locales }: Props) {
  return (
    <div className="space-y-8 max-w-4xl">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">02 //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">POS del local</h1>
      </div>

      <section>
        <SectionHeader
          icon={<TabletIcon className="h-3.5 w-3.5" />}
          code="A0"
          label="Dispositivos del local"
          count={1}
        />
        <Tablet localId={localId} locales={locales} />
      </section>

      <section>
        <SectionHeader
          icon={<KeyRound className="h-3.5 w-3.5" />}
          code="A1"
          label="Empleados con PIN"
        />
        <PinPos localId={localId} locales={locales} />
      </section>
    </div>
  );
}
