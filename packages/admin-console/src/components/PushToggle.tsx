import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { subscribe, unsubscribe, isSubscribed, getPushState } from '@/lib/push';

interface Props {
  userId: number;
}

export function PushToggle({ userId }: Props) {
  const [state, setState] = useState({ supported: false, subscribed: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ps = getPushState();
    if (!ps.supported) {
      setState({ supported: false, subscribed: false });
      return;
    }
    void isSubscribed().then((sub) => {
      if (!cancelled) setState({ supported: true, subscribed: sub });
    });
    return () => { cancelled = true; };
  }, []);

  if (!state.supported) {
    // Safari / browser viejo / SSR. No mostrar nada.
    return null;
  }

  async function onToggle() {
    if (loading) return;
    setLoading(true);
    setError(null);
    if (state.subscribed) {
      const { ok, error: err } = await unsubscribe();
      setState({ supported: true, subscribed: !ok });
      if (!ok) setError(err || 'No se pudo desuscribir');
    } else {
      const { ok, error: err } = await subscribe(userId);
      setState({ supported: true, subscribed: ok });
      if (!ok) setError(err || 'No se pudo suscribir');
    }
    setLoading(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        disabled={loading}
        className="w-full text-left text-xs flex items-center gap-1.5 px-2 py-1.5 rounded text-admin-muted hover:text-admin-text hover:bg-admin-border/40 disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : state.subscribed ? (
          <Bell className="w-3.5 h-3.5 text-admin-success" />
        ) : (
          <BellOff className="w-3.5 h-3.5" />
        )}
        <span>{state.subscribed ? 'Notificaciones activas' : 'Activar notificaciones'}</span>
      </button>
      {error && (
        <div className="text-[10px] text-admin-danger px-2 mt-1">{error}</div>
      )}
    </div>
  );
}
