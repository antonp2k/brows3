import { useEffect } from 'react';
import { subscribeCacheInvalidation, type S3Object } from '@/lib/tauri';
import { previewCache as defaultCache, type PreviewCache, type PreviewContext } from '@/lib/previewPrefetch';

/**
 * Keeps the previous and next previewable files loaded around the current one.
 * Moving Next or Previous slides the window, so only the newly adjacent file is fetched.
 * Never loads more listing pages just to prefetch.
 */
export function usePreviewPrefetch({ sequence, index, open, ctx, cache = defaultCache }: {
  sequence: S3Object[]; index: number; open: boolean; ctx: PreviewContext; cache?: PreviewCache;
}) {
  const previous = open && index > 0 ? sequence[index - 1] : undefined;
  const current = open && index >= 0 ? sequence[index] : undefined;
  const next = open && index >= 0 ? sequence[index + 1] : undefined;

  useEffect(() => {
    if (!open) { cache.clear(); return; }
    return subscribeCacheInvalidation(scope => { if (scope === 'objects') cache.clear(); });
  }, [open, cache]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    cache.retain(ctx, [previous?.key, current.key, next?.key].filter((key): key is string => !!key));
    // Shares the dialog's request; neighbours start only after the visible file has loaded.
    cache.get(ctx, current.key, current.size).catch(() => undefined).then(() => {
      if (cancelled) return;
      if (previous) void cache.prefetch(ctx, previous);
      if (next) void cache.prefetch(ctx, next);
    });
    return () => { cancelled = true; };
  }, [cache, ctx, previous, current, next]);
}
