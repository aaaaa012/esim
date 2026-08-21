import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorModal from './error-modal';

describe('ErrorModal', () => {
  it('renders nothing when there is no error', () => {
    const { container } = render(<ErrorModal error={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the customer-safe error message in an accessible dialog', () => {
    render(<ErrorModal error="Your activation QR could not be loaded." onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Your activation QR could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss error/i })).toHaveFocus();
  });

  it('closes on Escape and on backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(<ErrorModal error="boom" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(container.firstChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores clicks that originate inside the dialog itself', () => {
    const onClose = vi.fn();
    const { container } = render(<ErrorModal error="boom" onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    void container;
  });
});
