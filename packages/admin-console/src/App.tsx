import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Sidebar } from './components/Sidebar';
import { Login } from './pages/Login';
import { Soporte } from './pages/Soporte';
import { Tenants } from './pages/Tenants';
import { Pagos } from './pages/Pagos';
import { Metricas } from './pages/Metricas';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-admin-bg">
        <div className="text-admin-muted text-sm">Cargando…</div>
      </div>
    );
  }

  if (auth.status === 'unauthenticated') {
    return <Login />;
  }

  if (auth.status === 'forbidden') {
    return <Login reason={auth.reason} />;
  }

  return (
    <div className="min-h-screen flex bg-admin-bg">
      <Sidebar user={auth.user} />
      <main className="flex-1 overflow-auto px-8 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/soporte" replace />} />
          <Route path="/soporte" element={<Soporte />} />
          <Route path="/tenants" element={<Tenants />} />
          <Route path="/pagos" element={<Pagos />} />
          <Route path="/metricas" element={<Metricas />} />
          <Route path="*" element={<Navigate to="/soporte" replace />} />
        </Routes>
      </main>
    </div>
  );
}
