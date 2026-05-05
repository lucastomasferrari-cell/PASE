import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { CatalogoLayout } from './pages/Catalogo/CatalogoLayout';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/catalogo" element={<CatalogoLayout />} />
        <Route path="*" element={<Navigate to="/catalogo" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
