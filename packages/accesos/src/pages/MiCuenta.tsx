// Mi cuenta — la persona logueada puede cambiar su propia contraseña.

import { useState } from 'react';
import { toast } from 'sonner';
import { Lock, User } from 'lucide-react';
import { db } from '@/lib/supabase';
import { SectionHeader, IconBox, Input, Label, Button } from '@/components/primitives';

export function MiCuenta({ email }: { email: string }) {
  const [nueva, setNueva] = useState('');
  const [confirma, setConfirma] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (nueva.length < 8) { toast.error('Mínimo 8 caracteres'); return; }
    if (nueva !== confirma) { toast.error('Las contraseñas no coinciden'); return; }
    setGuardando(true);
    const { error } = await db().auth.updateUser({ password: nueva });
    setGuardando(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Contraseña actualizada');
    setNueva(''); setConfirma('');
  }

  return (
    <div className="max-w-md">
      <SectionHeader label="Mi cuenta" />

      {/* Cuenta — bloque hairline con avatar + email. */}
      <div className="border-t border-b border-carbon-600 py-4 flex items-center gap-4">
        <IconBox className="w-11 h-11">
          <User className="h-5 w-5" />
        </IconBox>
        <div className="min-w-0">
          <div className="font-medium text-dim-50 truncate">{email}</div>
          <div className="mono text-[10px] uppercase tracking-widest2 text-dim-300 mt-0.5">Tu cuenta del ecosistema</div>
        </div>
      </div>

      {/* Cambiar contraseña. */}
      <div className="mt-8 space-y-4">
        <p className="mono text-[11px] uppercase tracking-widest2 text-dim-200 inline-flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5" /> Cambiar contraseña
        </p>
        <div className="space-y-4">
          <div>
            <Label htmlFor="mc-nueva">Nueva contraseña</Label>
            <Input id="mc-nueva" type="password" value={nueva} onChange={(e) => setNueva(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="mc-confirma">Repetir</Label>
            <Input id="mc-confirma" type="password" value={confirma} onChange={(e) => setConfirma(e.target.value)} />
          </div>
          <Button
            variant="primary"
            size="lg"
            onClick={() => void submit()}
            disabled={guardando || !nueva || !confirma}
            className="w-full border border-brand-400/20 hover:border-brand-400/50"
          >
            {guardando ? 'Guardando…' : 'Actualizar contraseña'}
          </Button>
        </div>
      </div>
    </div>
  );
}
