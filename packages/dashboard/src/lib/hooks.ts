/**
 * Shared React hooks.
 */
import { useEffect } from 'react';

/**
 * Invoke `onEscape` on Escape key presses while `active` (default: always).
 * Used by modals/dialogs as the keyboard counterpart of the backdrop click.
 */
export function useEscapeKey(onEscape: () => void, active = true): void {
    useEffect(() => {
        if (!active) {
            return undefined;
        }
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onEscape();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onEscape, active]);
}
