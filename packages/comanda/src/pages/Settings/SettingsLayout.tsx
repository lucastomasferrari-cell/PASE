import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { SettingsEmpleados } from './SettingsEmpleados';

type Tab = 'empleados' | 'general' | 'mesas' | 'metodos' | 'catalogo';

const TABS: Array<{ key: Tab; label: string; emoji: string; disabled?: boolean }> = [
  { key: 'empleados', label: 'Empleados POS', emoji: '👥' },
  { key: 'general',   label: 'General',       emoji: '⚙️', disabled: true },
  { key: 'mesas',     label: 'Mesas',         emoji: '🪑', disabled: true },
  { key: 'metodos',   label: 'Métodos cobro', emoji: '💳', disabled: true },
  { key: 'catalogo',  label: 'Catálogo →',    emoji: '📋' },
];

export function SettingsLayout() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('empleados');

  if (!user) return null;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Configuración</h1>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 24 }}>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {TABS.map((t) => {
            const active = tab === t.key;
            const onClick = () => {
              if (t.key === 'catalogo') { window.location.href = '/catalogo'; return; }
              if (!t.disabled) setTab(t.key);
            };
            return (
              <button
                key={t.key}
                type="button"
                onClick={onClick}
                disabled={t.disabled}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  border: 'none',
                  borderRadius: 6,
                  background: active ? '#EEF2FF' : 'transparent',
                  color: active ? '#1E40AF' : t.disabled ? '#9CA3AF' : '#374151',
                  cursor: t.disabled ? 'default' : 'pointer',
                  fontSize: 14,
                  fontWeight: active ? 600 : 400,
                }}
              >
                <span style={{ marginRight: 6 }}>{t.emoji}</span>
                {t.label}
                {t.disabled && <span style={{ fontSize: 10, marginLeft: 6, color: '#9CA3AF' }}>(próx.)</span>}
              </button>
            );
          })}
        </nav>

        <main>
          {tab === 'empleados' && <SettingsEmpleados user={user} />}
          {tab === 'general' && <Placeholder>Sección General — próximo sprint.</Placeholder>}
          {tab === 'mesas' && <Placeholder>CRUD de mesas — próximo sprint.</Placeholder>}
          {tab === 'metodos' && <Placeholder>Métodos de cobro — próximo sprint.</Placeholder>}
        </main>
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 32, border: '1px dashed #D1D5DB', borderRadius: 8, color: '#6B7280', textAlign: 'center' }}>
      {children}
    </div>
  );
}
