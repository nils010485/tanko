/**
 * Shared chapter list: rows of (title + right-side actions) rendered in
 * increasing batches so thousand-chapter series stay usable without any
 * silent truncation. Also hosts the shared status → badge-tone mapping.
 */
import type { LibraryChapterDto } from '@tanko/shared';
import { type ReactNode, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.js';
import type { BadgeTone } from './ui.js';

export interface ChapterListItem {
    key: string;
    title: string;
    node?: ReactNode;
}

/** Optional row selection (checkbox + shift-click range) driven by the parent. */
export interface ChapterListSelection {
    selected: ReadonlySet<string>;
    onChange: (next: Set<string>) => void;
}

const BATCH = 200;

export function chapterTone(status: LibraryChapterDto['status']): BadgeTone {
    switch (status) {
        case 'downloaded':
            return 'green';
        case 'failed':
            return 'red';
        case 'new':
            return 'orange';
        case 'queued':
        case 'downloading':
            return 'blue';
        default:
            return 'zinc';
    }
}

export function ChapterList({ items, selection, resetKey }: { items: ChapterListItem[]; selection?: ChapterListSelection; resetKey: string | number }) {
    const [visible, setVisible] = useState(BATCH);
    const [seenKey, setSeenKey] = useState(resetKey);
    const { t } = useI18n();
    const anchorRef = useRef<string | null>(null);

    // a different list identity (series switch) restarts from the first batch
    if (seenKey !== resetKey) {
        setSeenKey(resetKey);
        setVisible(BATCH);
        anchorRef.current = null;
    }

    /** Toggle one row, or the whole anchor→key range on shift-click. */
    const toggle = (key: string, range: boolean) => {
        if (!selection) {
            return;
        }
        const next = new Set(selection.selected);
        const anchor = anchorRef.current;
        const from = items.findIndex(item => item.key === anchor);
        const to = items.findIndex(item => item.key === key);
        if (range && anchor !== null && from >= 0 && to >= 0) {
            for (const item of items.slice(Math.min(from, to), Math.max(from, to) + 1)) {
                next.add(item.key);
            }
        } else {
            anchorRef.current = key;
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
        }
        selection.onChange(next);
    };

    return (
        <div className="space-y-1">
            {items.slice(0, visible).map(item => (
                <div key={item.key} className="flex items-center justify-between gap-2 rounded-md bg-zinc-900/60 px-3 py-1.5">
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                        {selection && (
                            // readOnly: the state is driven by onClick (which also carries the shift key)
                            <input
                                type="checkbox"
                                checked={selection.selected.has(item.key)}
                                onClick={event => toggle(item.key, event.shiftKey)}
                                aria-label={item.title}
                                className="flex-none accent-orange-500"
                                readOnly
                            />
                        )}
                        <span className="min-w-0 flex-1 truncate text-zinc-300" title={item.title}>
                            {item.title}
                        </span>
                    </span>
                    {item.node}
                </div>
            ))}
            {items.length > visible && (
                <button
                    type="button"
                    onClick={() => setVisible(current => current + BATCH)}
                    className="w-full rounded-md border border-line px-3 py-2 text-xs text-muted transition-colors hover:border-zinc-600 hover:text-fg"
                >
                    {t('common.showMore', { n: Math.min(BATCH, items.length - visible) })}
                </button>
            )}
        </div>
    );
}
