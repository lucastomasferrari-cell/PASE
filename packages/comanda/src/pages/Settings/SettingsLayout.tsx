import {
  Users, Settings as SettingsIcon, Armchair, CreditCard, ClipboardList,
  KeyRound, ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { SettingsEmpleados } from './SettingsEmpleados';
import { SettingsLocal } from './SettingsLocal';
import { SettingsMesas } from './SettingsMesas';
import { SettingsMetodosCobro } from './SettingsMetodosCobro';
import { SettingsPermisos } from './SettingsPermisos';
import { SettingsAuditoria } from './SettingsAuditoria';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

type Tab = 'empleados' | 'local' | 'mesas' | 'metodos' | 'permisos' | 'auditoria';

const TABS = [
  { key: 'empleados' as const, label: 'Empleados POS', Icon: Users },
  { key: 'local' as const,     label: 'General',       Icon: SettingsIcon },
  { key: 'mesas' as const,     label: 'Mesas',         Icon: Armchair },
  { key: 'metodos' as const,   label: 'Métodos cobro', Icon: CreditCard },
  { key: 'permisos' as const,  label: 'Permisos',      Icon: KeyRound },
  { key: 'auditoria' as const, label: 'Auditoría',     Icon: ShieldCheck },
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
        <TabsList className="bg-transparent border-b border-border w-full justify-start rounded-none h-auto p-0 mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              className="data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 py-3 gap-2 whitespace-nowrap"
            >
              <t.Icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="empleados"><SettingsEmpleados user={user} /></TabsContent>
        <TabsContent value="local"><SettingsLocal /></TabsContent>
        <TabsContent value="mesas"><SettingsMesas /></TabsContent>
        <TabsContent value="metodos"><SettingsMetodosCobro /></TabsContent>
        <TabsContent value="permisos"><SettingsPermisos /></TabsContent>
        <TabsContent value="auditoria"><SettingsAuditoria /></TabsContent>
      </Tabs>
    </div>
  );
}
