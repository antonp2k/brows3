import { useMemo } from 'react';
import { objectApi, type S3Object } from '@/lib/tauri';
import { getObjectKind, getObjectName } from '@/lib/objectCapabilities';
import { useProfileStore } from '@/store/profileStore';
import { useSettingsStore } from '@/store/settingsStore';

/** Neighbours at or above this listing size are not prefetched. */
export const PREFETCH_MAX_BYTES = 10 * 1024 * 1024;
const PRESIGN_SECONDS = 3600;
// Signed URLs must stay usable for the whole time they are displayed.
const MEDIA_MAX_AGE_MS = 50 * 60 * 1000;
// Text can change remotely; saving is still ETag-guarded if a stale copy is shown.
const TEXT_MAX_AGE_MS = 5 * 60 * 1000;

export interface PreviewContext { profileId: string; bucketName: string; bucketRegion: string; maxTextMb: number }

export type PreviewPayload =
  | { kind: 'media'; objectKind: 'image' | 'audio' | 'video' | 'pdf'; contentType: string | null; url: string; image?: HTMLImageElement }
  | { kind: 'text'; contentType: string | null; content: string; etag: string | null; profileId: string }
  | { kind: 'unavailable'; contentType: string | null; message: string };

export const shouldPrefetch = (object: S3Object) => Number.isFinite(object.size) && object.size >= 0 && object.size < PREFETCH_MAX_BYTES;

export function usePreviewContext(bucketName: string, bucketRegion: string): PreviewContext {
  const profileId = useProfileStore(state => state.activeProfileId) || '';
  const maxTextMb = useSettingsStore(state => state.maxTextPreviewSizeMb);
  return useMemo(() => ({ profileId, bucketName, bucketRegion, maxTextMb }), [profileId, bucketName, bucketRegion, maxTextMb]);
}

async function warmImage(url: string) {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  // Holding the decoded element keeps the bytes in the webview's memory cache for the viewer's <img>.
  try { await image.decode?.(); return image; } catch { return undefined; }
}

export async function loadPreviewPayload(ctx: PreviewContext, key: string, sizeHint: number | undefined, warm: boolean): Promise<PreviewPayload> {
  const filename = getObjectName(key);
  let contentType: string | null = null;
  let size = sizeHint;
  try {
    const metadata = await objectApi.getObjectMetadata(ctx.bucketName, ctx.bucketRegion, key);
    contentType = metadata.content_type;
    size = metadata.size;
  } catch (err) {
    console.warn('Failed to load object metadata, falling back to filename-based detection:', err);
  }
  const kind = getObjectKind(filename, contentType);
  const maxTextBytes = ctx.maxTextMb * 1024 * 1024;
  if (kind === 'text') {
    if (size && size > maxTextBytes) {
      return { kind: 'unavailable', contentType, message: `File is too large to preview (${(size / 1024 / 1024).toFixed(2)} MB). Increase the ${ctx.maxTextMb} MB text preview limit in Settings or download it.` };
    }
    const text = await objectApi.getObjectContent(ctx.bucketName, ctx.bucketRegion, key, maxTextBytes);
    return { kind: 'text', contentType, content: text.content, etag: text.e_tag, profileId: text.profile_id };
  }
  if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'pdf') {
    const url = await objectApi.getPresignedUrl(ctx.bucketName, ctx.bucketRegion, key, PRESIGN_SECONDS);
    // Option B: only images get their bytes prefetched; other media prefetch metadata and the signed URL.
    const image = warm && kind === 'image' ? await warmImage(url) : undefined;
    return { kind: 'media', objectKind: kind, contentType, url, image };
  }
  return { kind: 'unavailable', contentType, message: 'This object is not previewable in the app. Please download it to inspect locally.' };
}

interface Entry { promise: Promise<PreviewPayload>; value?: PreviewPayload; settledAt?: number }

export class PreviewCache {
  private entries = new Map<string, Entry>();
  constructor(private load = loadPreviewPayload, private now = () => Date.now()) {}

  static id(ctx: PreviewContext, key: string) {
    return JSON.stringify([ctx.profileId, ctx.bucketName, ctx.bucketRegion, ctx.maxTextMb, key]);
  }

  private fresh(entry: Entry) {
    if (!entry.value || entry.settledAt === undefined) return true; // in flight
    const maxAge = entry.value.kind === 'media' ? MEDIA_MAX_AGE_MS : TEXT_MAX_AGE_MS;
    return this.now() - entry.settledAt < maxAge;
  }

  /** Returns the shared request for a key, starting one if none is cached and fresh. */
  get(ctx: PreviewContext, key: string, sizeHint?: number, warm = false): Promise<PreviewPayload> {
    const id = PreviewCache.id(ctx, key);
    const existing = this.entries.get(id);
    if (existing && this.fresh(existing)) return existing.promise;
    const entry: Entry = { promise: this.load(ctx, key, sizeHint, warm) };
    this.entries.set(id, entry);
    entry.promise.then(
      value => { entry.value = value; entry.settledAt = this.now(); },
      // Failed loads are never cached, so Retry and later visits ask again.
      () => { if (this.entries.get(id) === entry) this.entries.delete(id); },
    );
    return entry.promise;
  }

  prefetch(ctx: PreviewContext, object: S3Object) {
    if (!shouldPrefetch(object)) return Promise.resolve();
    return this.get(ctx, object.key, object.size, true).then(() => undefined, () => undefined);
  }

  /** Synchronous access to a loaded, fresh payload so navigation can skip the spinner. */
  peek(ctx: PreviewContext, key: string) {
    const entry = this.entries.get(PreviewCache.id(ctx, key));
    return entry?.value && this.fresh(entry) ? entry.value : undefined;
  }

  delete(ctx: PreviewContext, key: string) { this.entries.delete(PreviewCache.id(ctx, key)); }

  /** Evicts everything except the given keys in the given context. */
  retain(ctx: PreviewContext, keys: string[]) {
    const keep = new Set(keys.map(key => PreviewCache.id(ctx, key)));
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
  }

  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
}

export const previewCache = new PreviewCache();
