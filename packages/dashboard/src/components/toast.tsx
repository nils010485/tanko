/**
 * Minimal toast system: <ToastProvider> at the root, useToast() anywhere.
 * Toasts auto-dismiss and stack in the bottom-right corner.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'info';

interface Toast {
    id: number;
    tone: ToastTone;
    message: string;
}

interface ToastApi {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
    const api = useContext(ToastContext);
    if (!api) {
        throw new Error('useToast() must be used inside <ToastProvider>');
    }
    return api;
}

const TONES: Record<ToastTone, string> = {
    success: 'border-emerald-500/40 text-emerald-300',
    error: 'border-red-500/40 text-red-300',
    info: 'border-sky-500/40 text-sky-300'
};

const DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextId = useRef(1);

    const push = useCallback((tone: ToastTone, message: string) => {
        const id = nextId.current++;
        setToasts(current => [...current.slice(-4), { id, tone, message }]);
        setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), DISMISS_MS);
    }, []);

    const api = useRef<ToastApi>({
        success: message => push('success', message),
        error: message => push('error', message),
        info: message => push('info', message)
    }).current;

    return (
        <ToastContext.Provider value={api}>
            {children}
            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
                {toasts.map(toast => (
                    <div
                        key={toast.id}
                        role="status"
                        onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}
                        className={`pointer-events-auto cursor-pointer break-words rounded-lg border bg-zinc-900/95 px-3.5 py-2.5 text-sm shadow-lg shadow-black/40 backdrop-blur transition-all ${TONES[toast.tone]}`}
                    >
                        {toast.message}
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
