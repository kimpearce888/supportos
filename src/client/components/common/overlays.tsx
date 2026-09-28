import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUiStore } from '../../state/uiStore.js';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

// v2.2.1 audit fix: every mounted Modal used to register its own window-level
// Escape listener, so a single keypress dismissed ALL stacked dialogs (e.g.
// Tags editor open on top of the send confirmation). A module-level mount
// stack lets only the topmost dialog respond.
const modalStack: symbol[] = [];

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }): ReactNode {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef<symbol>(Symbol('modal'));

  useEffect(() => {
    modalStack.push(idRef.current);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === idRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      const idx = modalStack.indexOf(idRef.current);
      if (idx > -1) modalStack.splice(idx, 1);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Move focus into the dialog when it opens so keyboard/screen-reader users land inside it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    (dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialog).focus();
  }, []);

  // Lightweight Tab focus trap: cycle within the dialog's focusable elements.
  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === dialog || !dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || active === dialog || !dialog.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
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
