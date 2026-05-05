import type { ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar',
  destructive, onConfirm, onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: '#FFFFFF', borderRadius: 8, padding: 20, maxWidth: 420, width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
        }}
      >
        <h3 id="confirm-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
        <div style={{ marginTop: 8, fontSize: 14, color: '#374151', lineHeight: 1.5 }}>{message}</div>
        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 }}
          >{cancelLabel}</button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              padding: '6px 14px',
              border: 'none',
              borderRadius: 6,
              background: destructive ? '#DC2626' : '#2563EB',
              color: '#FFFFFF',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 500,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
