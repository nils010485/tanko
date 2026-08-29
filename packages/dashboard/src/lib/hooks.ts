/**
 * Shared React hooks.
 */
import type React from 'react';
import { useEffect, useRef } from 'react';

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

/**
 * Long-press (~500 ms, steady pointer) gesture for cards/rows: returns a
 * factory of pointer handlers that fires `onPress(id)` when the press holds.
 * Moving >10 px or releasing early cancels. The release click that follows a
 * fired press is swallowed — it would land on the re-rendered handlers and
 * undo what the press just did. On touch, long-press would otherwise open
 * the context menu, which is prevented here too.
 */
export function useLongPress(enabled: boolean, onPress: (id: number) => void) {
    const pressState = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
    const pressFired = useRef(false);
    const clearPress = () => {
        if (pressState.current) {
            clearTimeout(pressState.current.timer);
            pressState.current = null;
        }
    };
    return (id: number) => ({
        onPointerDown: (event: React.PointerEvent) => {
            if (!enabled) {
                return;
            }
            clearPress();
            pressFired.current = false;
            const { clientX: x, clientY: y } = event;
            pressState.current = {
                timer: setTimeout(() => {
                    pressState.current = null;
                    pressFired.current = true;
                    onPress(id);
                }, 500),
                x,
                y
            };
        },
        onPointerMove: (event: React.PointerEvent) => {
            const press = pressState.current;
            if (press && (Math.abs(event.clientX - press.x) > 10 || Math.abs(event.clientY - press.y) > 10)) {
                clearPress();
            }
        },
        onPointerUp: clearPress,
        onPointerLeave: clearPress,
        onPointerCancel: clearPress,
        onClickCapture: (event: React.MouseEvent) => {
            if (pressFired.current) {
                pressFired.current = false;
                event.preventDefault();
                event.stopPropagation();
            }
        },
        onContextMenu: (event: React.MouseEvent) => {
            if (pressState.current || pressFired.current) {
                event.preventDefault();
            }
        }
    });
}
