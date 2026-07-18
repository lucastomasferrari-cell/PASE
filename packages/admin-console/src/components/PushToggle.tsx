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
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={error ?? (state.subscribed ? 'Notificaciones activas' : 'Activar notificaciones')}
      className={`transition-colors disabled:opacity-50 ${state.subscribed ? 'text-admin-accent' : 'text-admin-muted hover:text-admin-accent'}`}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : state.subscribed ? (
        <Bell className="w-4 h-4" />
      ) : (
        <BellOff className="w-4 h-4" />
      )}
    </button>
  );
}
