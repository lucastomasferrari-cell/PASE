import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { ItemsTab } from './ItemsTab';
import { GruposTab } from './GruposTab';
import { CanalesTab } from './CanalesTab';
import { ListaPreciosTab } from './ListaPreciosTab';
import { ModificadoresTab } from './ModificadoresTab';

type TabKey = 'items' | 'grupos' | 'canales' | 'precios' | 'modificadores';

const TABS: Array<{ key: TabKey; label: string; emoji: string }> = [
  { key: 'items',         label: 'Items',           emoji: '📋' },
  { key: 'grupos',        label: 'Grupos',          emoji: '🗂️' },
  { key: 'canales',       label: 'Canales',         emoji: '🛍️' },
  { key: 'precios',       label: 'Lista de precios', emoji: '💲' },
  { key: 'modificadores', label: 'Modificadores',   emoji: '🎚️' },
];

export function CatalogoLayout() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>('items');

  // ProtectedShell garantiza user no-null cuando llegamos acá. Esta guarda
  // existe sólo para que TS pueda estrechar el tipo y los <Tabs user={...} />
  // reciban Usuario en vez de Usuario|null.
  if (!user) return null;

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Catálogo</h1>
      </header>

      <nav
        role="tablist"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid #E5E7EB',
          marginBottom: 20,
          overflowX: 'auto',
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                padding: '10px 16px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: active ? 600 : 400,
                color: active ? '#111827' : '#6B7280',
                borderBottom: active ? '2px solid #2563EB' : '2px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ marginRight: 6 }}>{t.emoji}</span>
              {t.label}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel">
        {tab === 'items' && <ItemsTab user={user} />}
        {tab === 'grupos' && <GruposTab user={user} />}
        {tab === 'canales' && <CanalesTab user={user} />}
        {tab === 'precios' && <ListaPreciosTab user={user} />}
        {tab === 'modificadores' && <ModificadoresTab user={user} />}
      </div>
    </div>
  );
}
