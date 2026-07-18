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
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-400 tracking-widest2">· //</span>
        <h1 className="text-2xl font-semibold text-dim-50 tracking-tight">Mi cuenta</h1>
      </div>
      <div className="border-t border-b border-carbon-600 bg-transparent p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-brand-100 text-brand-400 grid place-items-center font-medium">{(email[0] ?? '?').toUpperCase()}</div>
          <div>
            <div className="font-medium">{email}</div>
            <div className="text-xs text-dim-300">Tu cuenta del ecosistema</div>
          </div>
        </div>

        <p className="text-xs normal-case tracking-wide text-dim-300 mb-2 inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Cambiar contraseña</p>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-dim-200">Nueva contraseña</label>
            <input type="password" value={nueva} onChange={(e) => setNueva(e.target.value)} className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-dim-200">Repetir</label>
            <input type="password" value={confirma} onChange={(e) => setConfirma(e.target.value)} className="w-full bg-transparent border-b border-carbon-600 px-1 py-1.5 text-sm font-mono focus:outline-none focus:border-brand-400" />
          </div>
          <button onClick={() => void submit()} disabled={guardando || !nueva || !confirma}
                  className="w-full rounded-sm bg-brand-400 hover:bg-brand-500 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : 'Actualizar contraseña'}
          </button>
        </div>
      </div>
    </div>
  );
}
