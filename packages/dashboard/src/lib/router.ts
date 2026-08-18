/**
 * Tiny hash router: the active tab survives reloads and is shareable
 * (e.g. #/library). No dependency needed for a flat tab structure.
 */
import { useEffect, useState } from 'react';

export function useHashRoute<T extends string>(fallback: T, valid: readonly T[]): [T, (tab: T) => void] {
    const validRoutes = new Set<string>(valid);
    const read = (): T => {
        const hash = window.location.hash.replace(/^#\/?/, '');
        return validRoutes.has(hash) ? (hash as T) : fallback;
    };

    const [route, setRoute] = useState<T>(read);

    useEffect(() => {
        const onChange = () => setRoute(read());
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, []);

    const navigate = (tab: T) => {
        if (tab === route) return;
        window.location.hash = `/${tab}`;
        setRoute(tab);
    };

    return [route, navigate];
}
