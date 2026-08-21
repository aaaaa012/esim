'use client';

import { useEffect, useRef } from 'react';
import { AlertCircle, X } from 'lucide-react';

export default function ErrorModal({ error, onClose }: { error: string | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!error) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [error, onClose]);

  if (!error) return null;

  return (
    <div
      className="error-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="error-modal" role="dialog" aria-modal="true" aria-labelledby="error-modal-title" aria-describedby="error-modal-message">
        <button ref={closeRef} className="error-modal-close" onClick={onClose} aria-label="Dismiss error">
          <X />
        </button>
        <div className="error-modal-heading">
          <span className="error-modal-icon"><AlertCircle /></span>
          <h2 id="error-modal-title">Something went wrong</h2>
        </div>
        <p id="error-modal-message" className="error-modal-message">{error}</p>
      </div>
    </div>
  );
}