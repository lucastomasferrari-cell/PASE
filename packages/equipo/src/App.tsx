// Equipo — admin del dueño del local. Standalone, login propio, mismo Supabase.

import { Routes, Route } from 'react-router-dom';
import { AdminHome } from './pages/AdminHome';

export function App() {
  return (
    <Routes>
      <Route path="*" element={<AdminHome />} />
    </Routes>
  );
}
