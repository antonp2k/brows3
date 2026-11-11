import { beforeEach, expect, test, vi } from 'vitest';
import { LOCAL_CACHE_MAX_FILE_BYTES, loadPreviewPayload, PreviewCache, type PreviewContext } from '@/lib/previewPrefetch';
import { objectApi, previewCacheApi, type PreviewCacheLookup } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  objectApi: { getObjectMetadata: vi.fn(), getObjectContent: vi.fn(), getPresignedUrl: vi.fn() },
  previewCacheApi: { lookup: vi.fn(), fill: vi.fn(), readText: vi.fn(), fileUrl: vi.fn() },
}));

const ctx: PreviewContext = { profileId: 'p', bucketName: 'b', bucketRegion: 'r', maxTextMb: 2, localCacheMb: 1024 };
const lookup = (overrides: Partial<PreviewCacheLookup> = {}): PreviewCacheLookup => ({
  profile_id: 'p', size: 3, last_modified: '2026-01-01T00:00:00Z', content_type: 'image/png', e_tag: '"e"',
  local_path: null, offline: false, cacheable: true, ...overrides,
});

beforeEach(() => {
  vi.mocked(previewCacheApi.fill).mockResolvedValue('/cache/files/p/b/dir/a.png');
  vi.mocked(previewCacheApi.fileUrl).mockImplementation(async path => `asset://localhost${path}`);
  vi.mocked(previewCacheApi.readText).mockResolvedValue('cached text');
  vi.mocked(objectApi.getPresignedUrl).mockResolvedValue('https://s3/signed');
  vi.mocked(objectApi.getObjectMetadata).mockResolvedValue({ key: 'k', size: 3, content_type: 'image/png', e_tag: '"e"', last_modified: null, storage_class: null, user_metadata: {} });
});

test('a matching local copy is used without downloading or signing', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup({ local_path: '/cache/files/p/b/dir/a.png' }));
  const payload = await loadPreviewPayload(ctx, 'dir/a.png', 3, false);
  expect(payload).toMatchObject({ kind: 'media', objectKind: 'image', url: 'asset://localhost/cache/files/p/b/dir/a.png', local: true, offline: false });
  expect(previewCacheApi.fill).not.toHaveBeenCalled();
  expect(objectApi.getPresignedUrl).not.toHaveBeenCalled();
});

test('a missing or outdated copy downloads the validated version into the cache', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup());
  const payload = await loadPreviewPayload(ctx, 'dir/a.png', 3, false);
  expect(previewCacheApi.fill).toHaveBeenCalledWith('b', 'r', 'dir/a.png', '"e"', 3, 1024 * 1024 * 1024);
  expect(payload).toMatchObject({ kind: 'media', url: 'asset://localhost/cache/files/p/b/dir/a.png', local: true });
});

test('cached text keeps the ETag for guarded saves', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup({ content_type: 'text/plain', local_path: '/cache/files/p/b/a.txt' }));
  const payload = await loadPreviewPayload(ctx, 'a.txt', 3, false);
  expect(payload).toEqual({ kind: 'text', contentType: 'text/plain', content: 'cached text', etag: '"e"', profileId: 'p', local: true, offline: false });
  expect(previewCacheApi.readText).toHaveBeenCalledWith('b', 'a.txt', 2 * 1024 * 1024);
});

test('when the server is unreachable the last copy is shown as offline', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup({ local_path: '/cache/files/p/b/a.pdf', content_type: 'application/pdf', offline: true }));
  const payload = await loadPreviewPayload(ctx, 'a.pdf', 3, false);
  expect(payload).toMatchObject({ kind: 'media', objectKind: 'pdf', offline: true, local: true });
});

test('offline copies expire from the in-memory cache quickly', async () => {
  let now = 0;
  const load = vi.fn(async () => ({ kind: 'media' as const, objectKind: 'image' as const, contentType: null, url: 'asset://x', local: true, offline: true }));
  const cache = new PreviewCache(load, () => now);
  await cache.get(ctx, 'a.png');
  now += 31_000;
  expect(cache.peek(ctx, 'a.png')).toBeUndefined();
});

test('video and audio are streamed from S3 and never cached', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup({ content_type: 'video/mp4' }));
  const payload = await loadPreviewPayload(ctx, 'a.mp4', 3, false);
  expect(payload).toMatchObject({ kind: 'media', objectKind: 'video', url: 'https://s3/signed' });
  expect(previewCacheApi.fill).not.toHaveBeenCalled();
  expect(objectApi.getObjectMetadata).not.toHaveBeenCalled();
});

test('objects over the per-file limit or failed downloads fall back to S3', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup({ size: LOCAL_CACHE_MAX_FILE_BYTES + 1 }));
  expect(await loadPreviewPayload(ctx, 'big.png', undefined, false)).toMatchObject({ url: 'https://s3/signed' });
  expect(previewCacheApi.fill).not.toHaveBeenCalled();

  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup());
  vi.mocked(previewCacheApi.fill).mockRejectedValueOnce(new Error('disk full'));
  expect(await loadPreviewPayload(ctx, 'a.png', 3, false)).toMatchObject({ url: 'https://s3/signed' });
});

test('text over the preview limit is not downloaded', async () => {
  vi.mocked(previewCacheApi.lookup).mockResolvedValue(lookup({ content_type: 'text/plain', size: 3 * 1024 * 1024 }));
  expect(await loadPreviewPayload(ctx, 'a.txt', undefined, false)).toMatchObject({ kind: 'unavailable' });
  expect(previewCacheApi.fill).not.toHaveBeenCalled();
});

test('a disabled cache or failed lookup loads from S3 as before', async () => {
  await loadPreviewPayload({ ...ctx, localCacheMb: 0 }, 'a.png', 3, false);
  expect(previewCacheApi.lookup).not.toHaveBeenCalled();
  expect(objectApi.getObjectMetadata).toHaveBeenCalledTimes(1);

  vi.mocked(previewCacheApi.lookup).mockRejectedValueOnce(new Error('not found'));
  expect(await loadPreviewPayload(ctx, 'a.png', 3, false)).toMatchObject({ url: 'https://s3/signed' });
});
