import { Link } from 'react-router-dom';
import { UtensilsCrossed, Coffee, Package } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

const MODOS = [
  {
    slug: 'salon',
    title: 'Salón',
    description: 'Mesas con mozo y plano',
    Icon: UtensilsCrossed,
    iconBg: 'bg-primary/10',
    iconColor: 'text-primary',
  },
  {
    slug: 'mostrador',
    title: 'Mostrador',
    description: 'Para llevar / barra',
    Icon: Coffee,
    iconBg: 'bg-warning/10',
    iconColor: 'text-warning',
  },
  {
    slug: 'pedidos',
    title: 'Pedidos',
    description: 'Tienda online · WhatsApp',
    Icon: Package,
    iconBg: 'bg-success/10',
    iconColor: 'text-success',
  },
] as const;

export function PosSelectorModo() {
  return (
    <div className="flex items-center justify-center p-8 min-h-[calc(100vh-60px)]">
      <div className="w-full max-w-5xl">
        <div className="mb-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight mb-2">
            ¿Qué modo querés operar?
          </h2>
          <p className="text-muted-foreground">
            Elegí el modo del POS. Podés cambiar en cualquier momento desde el
            menú superior.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {MODOS.map((mode) => (
            <Link key={mode.slug} to={`/pos/${mode.slug}`} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
              <Card className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50 hover:-translate-y-0.5 h-full">
                <CardContent className="p-8">
                  <div
                    className={`inline-flex items-center justify-center w-16 h-16 rounded-2xl ${mode.iconBg} mb-6`}
                  >
                    <mode.Icon className={`h-8 w-8 ${mode.iconColor}`} />
                  </div>
                  <h3 className="text-2xl font-bold mb-1">{mode.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {mode.description}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
