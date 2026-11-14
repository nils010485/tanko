/**
 * Series cover with a three-step fallback: the locally cached first-chapter
 * cover (WebP in SQLite, instant), then the remote thumbnail through the
 * server-side image proxy (bypasses hotlink protection), then a letter
 * placeholder when nothing loads.
 */
import { useCallback, useState } from 'react';

function proxiedImage(url: string): string {
    return `/api/image?url=${encodeURIComponent(url)}`;
}

export function Cover({ title, thumbnail, coverUrl, className = '' }: { title: string; thumbnail?: string; coverUrl?: string; className?: string }) {
    const [brokenCover, setBrokenCover] = useState(false);
    const [brokenThumbnail, setBrokenThumbnail] = useState(false);
    const [loaded, setLoaded] = useState(false);
    // an image already in the browser cache may not fire onLoad after mount
    const markIfCached = useCallback((img: HTMLImageElement | null) => {
        if (img?.complete && img.naturalWidth > 0) setLoaded(true);
    }, []);
    const fade = `transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`;
    const image = (src: string, onError: () => void) => (
        <img
            ref={markIfCached}
            src={src}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={onError}
            className={`flex-none object-cover ${fade} ${className}`}
        />
    );

    if (coverUrl && !brokenCover) {
        return image(coverUrl, () => setBrokenCover(true));
    }

    if (thumbnail && !brokenThumbnail) {
        return image(proxiedImage(thumbnail), () => setBrokenThumbnail(true));
    }

    return (
        <div className={`flex flex-none items-center justify-center bg-line text-faint ${className}`} aria-hidden>
            <span className="text-lg font-semibold">{title.charAt(0).toUpperCase()}</span>
        </div>
    );
}
