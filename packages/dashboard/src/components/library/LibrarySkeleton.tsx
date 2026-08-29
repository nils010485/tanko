/**
 * Loading placeholders for the Library view, matching the current layout
 * (list rows or cover grid).
 */
import type { ViewMode } from '../../lib/library-filters.js';
import { gridClassName } from '../../lib/library-filters.js';
import { Card, Skeleton } from '../ui.js';

export function LibrarySkeleton({ view }: { view: ViewMode }) {
    if (view === 'list') {
        return (
            <div className="space-y-2">
                {['sk-a', 'sk-b', 'sk-c', 'sk-d'].map(key => (
                    <Card key={key} className="flex gap-3 p-2.5">
                        <Skeleton className="h-16 w-11 rounded-md" />
                        <div className="flex-1 space-y-2.5 py-1">
                            <Skeleton className="h-4 w-1/3" />
                            <Skeleton className="h-3 w-1/2" />
                        </div>
                    </Card>
                ))}
            </div>
        );
    }
    return (
        <div className={gridClassName(view)}>
            {['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e', 'sk-f', 'sk-g', 'sk-h', 'sk-i', 'sk-j'].map(key => (
                <Card key={key} className="overflow-hidden">
                    <Skeleton className="aspect-[2/3] w-full" />
                    <div className="space-y-2.5 p-3">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-3 w-1/2" />
                    </div>
                </Card>
            ))}
        </div>
    );
}
