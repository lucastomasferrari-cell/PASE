// Componente reutilizable para pantallas "Próximamente" (items del sidebar
// que existen visualmente pero todavía no tienen implementación).
//
// Cuando se construya la pantalla real, reemplazar el `case` correspondiente
// en App.tsx y eliminar el wrapper que use este placeholder.

import { Card } from "../components/ui";

interface PlaceholderProps {
  title: string;
  description: string;
}

export function Placeholder({ title, description }: PlaceholderProps) {
  return (
    <div>
      <div className="ph-row" style={{ marginBottom: 20 }}>
        <div>
          <div className="ph-title">{title}</div>
        </div>
      </div>
      <div style={{ maxWidth: 560 }}>
        <Card>
          <div style={{ padding: "8px 4px" }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--pase-text)", marginBottom: 8, letterSpacing: "-0.02em" }}>
              Próximamente
            </div>
            <div style={{ fontSize: 12, color: "var(--pase-text-muted)", lineHeight: 1.5, letterSpacing: "-0.005em" }}>
              {description}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default Placeholder;
