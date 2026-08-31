/**
 * Series cover with a three-step fallback: the locally cached first-chapter
 * cover (WebP in SQLite, instant), then the remote thumbnail through the
 * server-side image proxy (bypasses hotlink protection), then a letter
 * placeholder when nothing loads.
 */
import { useState } from 'react';

export function proxiedImage(url: string): string {
    return `/api/image?url=${encodeURIComponent(url)}`;
}

export function Cover({ title, thumbnail, coverUrl, className = '' }: { title: string; thumbnail?: string; coverUrl?: string; className?: string }) {
    const [brokenCover, setBrokenCover] = useState(false);
    const [brokenThumbnail, setBrokenThumbnail] = useState(false);

    if (coverUrl && !brokenCover) {
        return <img src={coverUrl} alt="" loading="lazy" onError={() => setBrokenCover(true)} className={`flex-none object-cover ${className}`} />;
    }

    if (thumbnail && !brokenThumbnail) {
        return (
            <img
                src={proxiedImage(thumbnail)}
                alt=""
                loading="lazy"
                onError={() => setBrokenThumbnail(true)}
                className={`flex-none object-cover ${className}`}
            />
        );
    }

    return (
        <div className={`flex flex-none items-center justify-center bg-line text-faint ${className}`} aria-hidden>
            <span className="text-lg font-semibold">{title.charAt(0).toUpperCase()}</span>
        </div>
    );
}
