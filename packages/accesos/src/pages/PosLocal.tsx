// POS del local — mundo operativo. Une en una sola pantalla las dos mitades
// del mismo flujo: la credencial del dispositivo (Tablet) y los PIN de cada
// empleado (PinPos). La tablet entra una vez con la cuenta del local; después
// cada uno se identifica con su PIN.
//
// Look Command Center (17-jul): sin cajas contenedoras. Cada sección es un
// header horizontal con label mono + count a la derecha + hairline debajo;
// los items viven directo debajo, separados por hairlines.

import { Tablet } from './Tablet';
import { PinPos } from './PinPos';
import { SectionHeader } from '@/components/primitives';

interface Props {
  localId: number | null;
  locales: { id: number; nombre: string }[];
}

export function PosLocal({ localId, locales }: Props) {
  return (
    <div className="space-y-12 max-w-4xl">
      <section>
        <SectionHeader label="A0 · Dispositivos del local" count={1} />
        <Tablet localId={localId} locales={locales} />
      </section>

      <section>
        <SectionHeader label="A1 · Empleados con PIN" />
        <PinPos localId={localId} locales={locales} />
      </section>
    </div>
  );
}
