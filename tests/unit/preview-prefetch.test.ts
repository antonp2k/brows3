import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PREFETCH_MAX_BYTES, PreviewCache, shouldPrefetch, type PreviewContext, type PreviewPayload } from '@/lib/previewPrefetch';
import { usePreviewPrefetch } from '@/hooks/usePreviewPrefetch';
import { invalidateCache, type S3Object } from '@/lib/tauri';

const ctx: PreviewContext = { profileId: 'p', bucketName: 'b', bucketRegion: 'us-east-1', maxTextMb: 2 };
const object = (key: string, size = 100): S3Object => ({ key, size, last_modified: null, storage_class: null });
const text = (content: string): PreviewPayload => ({ kind: 'text', contentType: 'text/plain', content, etag: 'e', profileId: 'p' });
const media = (url: string): PreviewPayload => ({ kind: 'media', objectKind: 'image', contentType: 'image/png', url });
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

function setup() {
  const load = vi.fn(async (_ctx: PreviewContext, key: string) => key.endsWith('.png') ? media(`https://s3/${key}`) : text(key));
  let now = 0;
  const cache = new PreviewCache(load, () => now);
  return { load, cache, advance: (ms: number) => { now += ms; } };
}
const loadedKeys = (load: ReturnType<typeof setup>['load']) => load.mock.calls.map(call => call[1]);

test('only neighbours smaller than 10 MB are prefetched', () => {
  expect(shouldPrefetch(object('a', 0))).toBe(true);
  expect(shouldPrefetch(object('a', PREFETCH_MAX_BYTES - 1))).toBe(true);
  expect(shouldPrefetch(object('a', PREFETCH_MAX_BYTES))).toBe(false);
  expect(shouldPrefetch(object('a', NaN))).toBe(false);
});

test('in-flight requests are shared and settled payloads are available synchronously', async () => {
  const { cache, load } = setup();
  const first = cache.get(ctx, 'a.txt');
  expect(cache.get(ctx, 'a.txt')).toBe(first);
  expect(cache.peek(ctx, 'a.txt')).toBeUndefined();
  await first;
  expect(cache.peek(ctx, 'a.txt')).toEqual(text('a.txt'));
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.peek({ ...ctx, profileId: 'other' }, 'a.txt')).toBeUndefined();
});

test('failures are not cached and signed URLs expire before S3 rejects them', async () => {
  const { cache, load, advance } = setup();
  load.mockRejectedValueOnce(new Error('offline'));
  await expect(cache.get(ctx, 'a.png')).rejects.toThrow('offline');
  await cache.get(ctx, 'a.png');
  expect(load).toHaveBeenCalledTimes(2);
  advance(49 * 60_000);
  expect(cache.peek(ctx, 'a.png')).toBeDefined();
  advance(2 * 60_000);
  expect(cache.peek(ctx, 'a.png')).toBeUndefined();
  await cache.get(ctx, 'a.png');
  expect(load).toHaveBeenCalledTimes(3);
});

test('prefetch skips large files and warms the rest', async () => {
  const { cache, load } = setup();
  await cache.prefetch(ctx, object('big.png', PREFETCH_MAX_BYTES));
  await cache.prefetch(ctx, object('small.png'));
  expect(load.mock.calls).toEqual([[ctx, 'small.png', 100, true]]);
});

test('the window slides: open loads both neighbours, each step loads only the new one', async () => {
  const { cache, load } = setup();
  const sequence = ['a', 'b', 'c', 'd', 'e'].map(k => object(`${k}.txt`));
  const view = renderHook(props => usePreviewPrefetch(props), { initialProps: { sequence, index: 2, open: true, ctx, cache } });
  await flush();
  expect(loadedKeys(load).sort()).toEqual(['b.txt', 'c.txt', 'd.txt']);

  load.mockClear();
  view.rerender({ sequence, index: 3, open: true, ctx, cache });
  await flush();
  expect(loadedKeys(load)).toEqual(['e.txt']);
  expect(cache.peek(ctx, 'b.txt')).toBeUndefined(); // evicted outside the window

  load.mockClear();
  view.rerender({ sequence, index: 2, open: true, ctx, cache });
  await flush();
  expect(loadedKeys(load)).toEqual(['b.txt']);
});

test('the window respects boundaries, the size limit, invalidation and closing', async () => {
  const { cache, load } = setup();
  const sequence = [object('a.txt'), object('b.txt'), object('huge.txt', PREFETCH_MAX_BYTES * 2)];
  const view = renderHook(props => usePreviewPrefetch(props), { initialProps: { sequence, index: 1, open: true, ctx, cache } });
  await flush();
  expect(loadedKeys(load).sort()).toEqual(['a.txt', 'b.txt']);
  act(() => invalidateCache('objects'));
  expect(cache.size).toBe(0);
  await cache.get(ctx, 'b.txt');
  view.rerender({ sequence, index: 1, open: false, ctx, cache });
  expect(cache.size).toBe(0);
});
