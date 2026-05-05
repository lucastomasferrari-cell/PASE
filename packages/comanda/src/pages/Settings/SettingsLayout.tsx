import { Users, Settings as SettingsIcon, ArmchairIcon, CreditCard, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { SettingsEmpleados } from './SettingsEmpleados';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';

type Tab = 'empleados' | 'general' | 'mesas' | 'metodos';

const TABS = [
  { key: 'empleados' as const, label: 'Empleados POS', Icon: Users },
  { key: 'general' as const,   label: 'General',       Icon: SettingsIcon, disabled: true },
  { key: 'mesas' as const,     label: 'Mesas',         Icon: ArmchairIcon, disabled: true },
  { key: 'metodos' as const,   label: 'Métodos cobro', Icon: CreditCard, disabled: true },
];

export function SettingsLayout() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('empleados');

  if (!user) return null;

  return (
    <div className="container py-8">
      <header className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Configuración</h1>
        <Link
          to="/catalogo"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ClipboardList className="h-4 w-4" />
          Ir al Catálogo →
        </Link>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="bg-transparent border-b border-border w-full justify-start rounded-none h-auto p-0 mb-6">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              disabled={t.disabled}
              className="data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 py-3 gap-2"
            >
              <t.Icon className="h-4 w-4" />
              {t.label}
              {t.disabled && <span className="text-[10px] text-muted-foreground ml-1">(próx.)</span>}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="empleados">
          <SettingsEmpleados user={user} />
        </TabsContent>
        <TabsContent value="general"><Placeholder>Sección General — próximo sprint.</Placeholder></TabsContent>
        <TabsContent value="mesas"><Placeholder>CRUD de mesas — próximo sprint.</Placeholder></TabsContent>
        <TabsContent value="metodos"><Placeholder>Métodos de cobro — próximo sprint.</Placeholder></TabsContent>
      </Tabs>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-16 text-center text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}
