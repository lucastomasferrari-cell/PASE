import { Check, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Props {
  titulo: string;
  descripcion: string;
  icono: LucideIcon;
  proximamenteEn?: string;
  features?: string[];
}

// Pantalla "Próximamente" reusable. Sprint 6: el sistema entero está
// visible en el sidebar admin aunque la mayoría de las features no
// existan todavía. Cada ruta nueva renderiza esta pantalla con copy
// específico (ver lib/stubsCopy.ts).
export function StubPantalla({ titulo, descripcion, icono: Icon, proximamenteEn = 'Próximamente', features = [] }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-8 text-center max-w-2xl mx-auto">
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <Icon className="h-8 w-8 text-primary" />
      </div>
      <Badge variant="outline" className="mb-4">{proximamenteEn}</Badge>
      <h1 className="text-2xl font-medium mb-3">{titulo}</h1>
      <p className="text-muted-foreground mb-6">{descripcion}</p>
      {features.length > 0 && (
        <div className="text-left bg-muted/30 rounded-lg p-6 w-full">
          <p className="text-sm font-medium mb-3">Cuando esté lista, vas a poder:</p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                <Check className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
