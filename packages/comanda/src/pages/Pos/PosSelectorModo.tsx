import { Link } from 'react-router-dom';

const MODOS = [
  { slug: 'salon',     label: 'Salón',     emoji: '🍽️', desc: 'Mesas con mozo y plano' },
  { slug: 'mostrador', label: 'Mostrador', emoji: '☕', desc: 'Para llevar / barra' },
  { slug: 'pedidos',   label: 'Pedidos',   emoji: '📦', desc: 'Tienda online · WhatsApp' },
];

export function PosSelectorModo() {
  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 16px' }}>
      <h2 style={{ margin: 0, fontSize: 24, marginBottom: 4 }}>¿Qué modo querés operar?</h2>
      <p style={{ margin: 0, fontSize: 14, color: '#6B7280', marginBottom: 24 }}>
        Elegí el modo del POS. Podés cambiar en cualquier momento desde el menú superior.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
        {MODOS.map((m) => (
          <Link
            key={m.slug}
            to={`/pos/${m.slug}`}
            style={card}
          >
            <div style={{ fontSize: 48 }}>{m.emoji}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>{m.label}</div>
            <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{m.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  display: 'block',
  padding: 24,
  border: '1px solid #E5E7EB',
  borderRadius: 12,
  background: '#FFFFFF',
  textAlign: 'center',
  textDecoration: 'none',
  color: '#111827',
  cursor: 'pointer',
  transition: 'transform 100ms, box-shadow 100ms',
  boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
};
