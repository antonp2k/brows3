import { useMemo } from 'react';
import { objectApi, previewCacheApi, type PreviewCacheLookup, type S3Object } from '@/lib/tauri';
import { getObjectKind, getObjectName } from '@/lib/objectCapabilities';
import { useProfileStore } from '@/store/profileStore';
import { useSettingsStore } from '@/store/settingsStore';

/** Neighbours at or above this listing size are not prefetched. */
export const PREFETCH_MAX_BYTES = 10 * 1024 * 1024;
const PRESIGN_SECONDS = 3600;
// Signed URLs must stay usable for the whole time they are displayed.
const MEDIA_MAX_AGE_MS = 50 * 60 * 1000;
// Text and local copies can change remotely, so they are revalidated after this. Saving is ETag-guarded.
const TEXT_MAX_AGE_MS = 5 * 60 * 1000;
// Offline copies are retried soon so the label clears once the server is reachable again.
const OFFLINE_MAX_AGE_MS = 30 * 1000;
/** Larger objects are previewed from S3 directly instead of being copied to the local cache. */
export const LOCAL_CACHE_MAX_FILE_BYTES = 100 * 1024 * 1024;
const CACHED_KINDS = new Set(['image', 'pdf', 'text']);

export interface PreviewContext {
  profileId: string; bucketName: string; bucketRegion: string; maxTextMb: number;
  /** Local disk cache limit in MB; 0 disables the cache. */
  localCacheMb?: number;
}

export type PreviewPayload =
  | { kind: 'media'; objectKind: 'image' | 'audio' | 'video' | 'pdf'; contentType: string | null; url: string; image?: HTMLImageElement; local?: boolean; offline?: boolean }
  | { kind: 'text'; contentType: string | null; content: string; etag: string | null; profileId: string; local?: boolean; offline?: boolean }
  | { kind: 'unavailable'; contentType: string | null; message: string };

export const OFFLINE_NOTICE = 'Offline copy: the server could not be reached, so this cached version may be outdated.';

export const shouldPrefetch = (object: S3Object) => Number.isFinite(object.size) && object.size >= 0 && object.size < PREFETCH_MAX_BYTES;

export function usePreviewContext(bucketName: string, bucketRegion: string): PreviewContext {
  const profileId = useProfileStore(state => state.activeProfileId) || '';
  const maxTextMb = useSettingsStore(state => state.maxTextPreviewSizeMb);
  const localCacheMb = useSettingsStore(state => state.localCacheEnabled ? state.localCacheMaxMb : 0);
  return useMemo(() => ({ profileId, bucketName, bucketRegion, maxTextMb, localCacheMb }), [profileId, bucketName, bucketRegion, maxTextMb, localCacheMb]);
}

async function warmImage(url: string) {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  // Holding the decoded element keeps the bytes in the webview's memory cache for the viewer's <img>.
  try { await image.decode?.(); return image; } catch { return undefined; }
}

const tooLargeForText = (ctx: PreviewContext, size: number): PreviewPayload => ({
  kind: 'unavailable', contentType: null,
  message: `File is too large to preview (${(size / 1024 / 1024).toFixed(2)} MB). Increase the ${ctx.maxTextMb} MB text preview limit in Settings or download it.`,
});

/** Loads a preview straight from S3 once the object's content type and size are known. */
async function loadRemotePayload(ctx: PreviewContext, key: string, contentType: string | null, size: number | undefined, warm: boolean): Promise<PreviewPayload> {
  const kind = getObjectKind(getObjectName(key), contentType);
  const maxTextBytes = ctx.maxTextMb * 1024 * 1024;
  if (kind === 'text') {
    if (size && size > maxTextBytes) return { ...tooLargeForText(ctx, size), contentType };
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

async function loadLocalPayload(ctx: PreviewContext, key: string, lookup: PreviewCacheLookup, path: string, warm: boolean): Promise<PreviewPayload> {
  const contentType = lookup.content_type;
  const offline = lookup.offline;
  const kind = getObjectKind(getObjectName(key), contentType);
  if (kind === 'text') {
    const content = await previewCacheApi.readText(ctx.bucketName, key, ctx.maxTextMb * 1024 * 1024);
    return { kind: 'text', contentType, content, etag: lookup.e_tag, profileId: lookup.profile_id, local: true, offline };
  }
  const url = await previewCacheApi.fileUrl(path);
  const image = warm && kind === 'image' ? await warmImage(url) : undefined;
  return { kind: 'media', objectKind: kind as 'image' | 'pdf', contentType, url, image, local: true, offline };
}

/**
 * Serves images, PDFs and text from the local disk cache while the copy's size, date and ETag
 * match the remote object, downloading a new copy otherwise. When the remote is unreachable, the
 * last copy is shown marked offline. Returns null to fall back to loading from S3.
 */
async function loadCachedPayload(ctx: PreviewContext, key: string, warm: boolean): Promise<PreviewPayload | null> {
  let lookup: PreviewCacheLookup;
  try {
    lookup = await previewCacheApi.lookup(ctx.bucketName, ctx.bucketRegion, key);
  } catch (err) {
    console.warn('Local cache lookup failed, loading from S3:', err);
    return null;
  }
  const kind = getObjectKind(getObjectName(key), lookup.content_type);
  const maxTextBytes = ctx.maxTextMb * 1024 * 1024;
  if (kind === 'text' && lookup.size > maxTextBytes) return { ...tooLargeForText(ctx, lookup.size), contentType: lookup.content_type };
  const cacheable = CACHED_KINDS.has(kind) && lookup.cacheable;
  if (cacheable && lookup.local_path) {
    try {
      return await loadLocalPayload(ctx, key, lookup, lookup.local_path, warm);
    } catch (err) {
      if (lookup.offline) throw err;
      console.warn('Cached copy unreadable, downloading again:', err);
    }
  }
  const maxCacheBytes = (ctx.localCacheMb ?? 0) * 1024 * 1024;
  if (cacheable && lookup.size <= Math.min(LOCAL_CACHE_MAX_FILE_BYTES, maxCacheBytes)) {
    try {
      const path = await previewCacheApi.fill(ctx.bucketName, ctx.bucketRegion, key, lookup.e_tag, lookup.size, maxCacheBytes);
      return await loadLocalPayload(ctx, key, { ...lookup, offline: false }, path, warm);
    } catch (err) {
      console.warn('Could not cache a local copy, loading from S3:', err);
    }
  }
  return loadRemotePayload(ctx, key, lookup.content_type, lookup.size, warm);
}

export async function loadPreviewPayload(ctx: PreviewContext, key: string, sizeHint: number | undefined, warm: boolean): Promise<PreviewPayload> {
  if (ctx.localCacheMb) {
    const cached = await loadCachedPayload(ctx, key, warm);
    if (cached) return cached;
  }
  let contentType: string | null = null;
  let size = sizeHint;
  try {
    const metadata = await objectApi.getObjectMetadata(ctx.bucketName, ctx.bucketRegion, key);
    contentType = metadata.content_type;
    size = metadata.size;
  } catch (err) {
    console.warn('Failed to load object metadata, falling back to filename-based detection:', err);
  }
  return loadRemotePayload(ctx, key, contentType, size, warm);
}

interface Entry { promise: Promise<PreviewPayload>; value?: PreviewPayload; settledAt?: number }

export class PreviewCache {
  private entries = new Map<string, Entry>();
  constructor(private load = loadPreviewPayload, private now = () => Date.now()) {}

  static id(ctx: PreviewContext, key: string) {
    return JSON.stringify([ctx.profileId, ctx.bucketName, ctx.bucketRegion, ctx.maxTextMb, ctx.localCacheMb ?? 0, key]);
  }

  private fresh(entry: Entry) {
    if (!entry.value || entry.settledAt === undefined) return true; // in flight
    const value = entry.value;
    const maxAge = value.kind !== 'unavailable' && value.offline ? OFFLINE_MAX_AGE_MS
      : value.kind === 'media' && !value.local ? MEDIA_MAX_AGE_MS : TEXT_MAX_AGE_MS;
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
