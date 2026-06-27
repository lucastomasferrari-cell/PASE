// Mi cuenta — la persona logueada puede cambiar su propia contraseña.

import { useState } from 'react';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { db } from '@/lib/supabase';

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
    <div className="space-y-5 max-w-md">
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium">{(email[0] ?? '?').toUpperCase()}</div>
          <div>
            <div className="font-medium">{email}</div>
            <div className="text-xs text-ink-muted">Tu cuenta del ecosistema</div>
          </div>
        </div>

        <p className="text-xs normal-case tracking-wide text-ink-muted mb-2 inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Cambiar contraseña</p>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Nueva contraseña</label>
            <input type="password" value={nueva} onChange={(e) => setNueva(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Repetir</label>
            <input type="password" value={confirma} onChange={(e) => setConfirma(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <button onClick={() => void submit()} disabled={guardando || !nueva || !confirma}
                  className="w-full rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : 'Actualizar contraseña'}
          </button>
        </div>
      </div>
    </div>
  );
}
