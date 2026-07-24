import { useAuth } from '@/lib/auth';
import { ItemsTab } from '@/pages/Catalogo/ItemsTab';
import { GruposTab } from '@/pages/Catalogo/GruposTab';
import { CanalesTab } from '@/pages/Catalogo/CanalesTab';
import { ListaPreciosTab } from '@/pages/Catalogo/ListaPreciosTab';
import { PreciosPage } from '@/pages/Catalogo/PreciosPage';
import { ModificadoresTab } from '@/pages/Catalogo/ModificadoresTab';
import { SettingsEmpleados } from '@/pages/Settings/SettingsEmpleados';

// Wrappers thin que inyectan el `user` desde useAuth a las páginas
// existentes que lo esperan como prop. Fueron diseñadas para el viejo
// CatalogoLayout / SettingsLayout que pasaba user explícito; con el
// nuevo AdminLayout cada página se monta como ruta independiente.
//
// Si el user todavía no cargó (loading), no renderizamos — AdminLayout
// ya maneja el loading global.

function withUser<P extends { user: import('@/types/auth').Usuario }>(
  Component: React.ComponentType<P>,
): React.FC<Omit<P, 'user'>> {
  const Wrapper: React.FC<Omit<P, 'user'>> = (props) => {
    const { user } = useAuth();
    if (!user) return null;
    return <Component {...(props as P)} user={user} />;
  };
  Wrapper.displayName = `WithUser(${Component.displayName ?? Component.name})`;
  return Wrapper;
}

export const ItemsRoute       = withUser(ItemsTab);
export const GruposRoute      = withUser(GruposTab);
export const CanalesRoute     = withUser(CanalesTab);
// Precios unificado: una sección con pestañas Planilla / Listas.
// /menu/lista-precios abre en Planilla; /menu/listas-precios en Listas.
export const PreciosRoute = withUser(PreciosPage);
export const PreciosRouteListas = () => {
  const { user } = useAuth();
  if (!user) return null;
  return <PreciosPage user={user} defaultTab="listas" />;
};
export const ModificadoresRoute = withUser(ModificadoresTab);
export const EmpleadosListaRoute = withUser(SettingsEmpleados);

// ─── Menú Marca (maestro dueño-only) ──────────────────────────────────
// Wrappers que fuerzan el scope a 'maestro'. Las rutas /menu/maestro/*
// las montan; el CatalogoScopeSelector queda oculto (forceScope lo silencia
// dentro de cada tab). Estas rutas están gatadas por permiso en el sidebar.
export const ItemsRouteMaestro = () => {
  const { user } = useAuth();
  if (!user) return null;
  return <ItemsTab user={user} forceScope="maestro" />;
};
export const GruposRouteMaestro = () => {
  const { user } = useAuth();
  if (!user) return null;
  return <GruposTab user={user} forceScope="maestro" />;
};
export const ListaPreciosRouteMaestro = () => {
  const { user } = useAuth();
  if (!user) return null;
  return <ListaPreciosTab user={user} forceScope="maestro" />;
};
