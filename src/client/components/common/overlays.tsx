import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUiStore } from '../../state/uiStore.js';

export function Toasts(): ReactNode {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <div className="flex-between" style={{ alignItems: 'flex-start' }}>
            <div>
              {t.message}
              {t.detail ? (
                <details style={{ marginTop: 4 }}>
                  <summary className="text-xs muted" style={{ cursor: 'pointer' }}>
                    Technical details
                  </summary>
                  <div className="mono" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                    {t.detail}
                  </div>
                </details>
              ) : null}
            </div>
            <button className="btn ghost small" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <span>{title}</span>
          <button className="btn ghost small" aria-label="Close dialog" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }): ReactNode {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{message}</p>
    </Modal>
  );
}
