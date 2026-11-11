# Preview selection and navigation

Preview files and build a selection without closing the dialog. The Select/Selected toggle shares the bucket table's selection state, so selection persists after closing the preview. Selection and navigation do not automatically download, copy, move, delete, or save files.

## Ordering and pagination

Previous and Next follow the table's current sorting and filtering across a mixed sequence of previewable files. Folders and unsupported files are skipped; duplicate object keys appear once. Navigation does not wrap. The position counter describes currently loaded previewable files, not the total number of objects in the bucket.

At the end of the loaded sequence, Next can fetch additional listing pages. Each attempt searches at most 20 pages, including pages containing only unsupported files or folders. Navigation is serialized within the active preview context. The dialog reports loading and errors; Next can retry a failed request or continue after the 20-page limit. A repeated continuation cursor prompts a folder refresh. Deep search navigates its supplied results without this listing pagination.

Context identity guards prevent completed requests from navigating a closed preview or applying navigation to a different object, folder, sort, or search context.

## Prefetching

While a preview is open, the previous and next previewable files are loaded in advance so navigation shows them without a spinner. The window slides: opening a preview loads both neighbours after the visible file has loaded, Next loads one more next file, and Previous loads one more previous file. Files outside the window are evicted.

- Only neighbours smaller than 10 MB (by listing size) are prefetched. Larger files load when they become visible.
- Images, PDFs and text files are saved to the local preview cache (see below); images are also decoded in advance. Video and audio files get metadata and a signed URL only.
- Prefetching never loads additional listing pages.
- Signed URLs are reused for 50 minutes; text and local copies are rechecked against S3 after 5 minutes. Failed loads are not cached, and Retry always requests a fresh load.
- Closing the preview, saving, object cache invalidation, and profile, bucket, or text-limit changes discard prefetched content. Saving prefetched text remains ETag-guarded.

## Local preview cache

Images, PDFs and text files that are previewed or prefetched are stored on disk, in the app cache directory under `preview-cache/files/<profile id>/<bucket>/<object key>`. The folder structure mirrors the remote keys. Video and audio are always streamed from S3.

When a file is opened:

1. The app asks S3 for the object's size, `LastModified` and ETag (one HEAD request).
2. If a local copy exists and its size, modification date and ETag all match, the local copy is shown.
3. Otherwise the object is downloaded into the cache, pinned to the ETag it was checked against (`If-Match`). Its file modification time is set to the object's `LastModified`, and it replaces the old copy atomically.
4. If S3 cannot be reached and a local copy exists, that copy is shown with an "Offline copy" label. Offline results are rechecked after 30 seconds.

Details:

- ETags, sizes, dates and last-access times are kept in `preview-cache/index.json`. A copy whose file was changed on disk, or that is missing from the index, is never trusted.
- Key segments that are not valid file names on every platform are percent-encoded: `%`, `<>:"|?*\`, control characters, trailing dots or spaces, Windows device names such as `CON`, and empty, `.` or `..` segments. Keys that differ only in letter case never share a copy, even on case-insensitive file systems.
- An object whose name matches an existing cached folder (for example `photos` next to `photos/a.jpg`) is previewed from S3 without being cached.
- Objects over 100 MB, text over the text preview limit, and objects without a `LastModified` date are not cached.
- Above the size limit in Settings (default 1 GB), the least recently used copies are removed. Settings can also disable or clear the cache. Deleting a profile removes its cached files. Saving a text file removes its copy, so the next preview downloads the new version.
- On startup, orphaned files, index entries without intact files, and partial downloads older than one hour are removed.
- The webview loads cached files through Tauri's asset protocol, scoped to `$APPCACHE/preview-cache/files/**`.

## Controls and draft protection

- Left and Right move between previews; Space toggles file selection. Space on a focused button retains the button's native activation.
- Text inputs, editable content, Monaco, embedded documents, and native audio/video controls retain their keyboard behavior instead of triggering generic preview shortcuts.
- In the image viewer, Shift plus arrow keys pans while Left and Right switch previews. Scroll or pinch zooms; drag pans; plus/minus zoom, `0` fits, and `1` shows actual size.
- Editing or saving blocks file navigation. Closing or canceling an edit with unsaved changes requires choosing Discard changes or Keep editing. Closing is blocked during saving.
- Draft state compares edited text with the loaded or saved content baseline. Undoing back to that baseline or discarding a draft clears the dirty state, even when Monaco has assigned a new model version.

## Implementation and visual authority

The existing image viewer and BaseDialog remain authoritative. Preserve their light/dark theme, image zoom and pan, and compact rounded controls. Selection and navigation extend these surfaces; this feature does not establish a new visual design system.

| Source | Responsibility |
| --- | --- |
| `src/hooks/usePreviewNavigation.ts` | Previewable sequence, boundaries, bounded pagination, retry feedback, and stale-result guards |
| `src/lib/previewPrefetch.ts` | Shared preview loader (local cache first, S3 fallback), prefetch size limit, and request cache with expiry |
| `src-tauri/src/preview_cache.rs` | On-disk layout, key encoding, version index, validation, eviction and cleanup |
| `src-tauri/src/commands/preview_cache.rs` | HEAD with offline fallback, ETag-pinned fill, cached text reads, usage and clearing |
| `src/hooks/usePreviewPrefetch.ts` | Sliding previous/next prefetch window and cache clearing |
| `src/lib/objectSort.ts` | Shared table and preview comparison for name, size, date, and storage class |
| `src/components/dialogs/ObjectPreviewDialog.tsx` | Mixed file previews, selection controls, keyboard exclusions, editing and discard protection |
| `src/components/dialogs/ImagePreviewViewer.tsx` | Existing image rendering, zoom and pan, plus selection and navigation controls |
| `src/app/bucket/page.tsx` | Current table data, sorting/search context, pagination, and persistent selection wiring |

Selection/navigation and shared sorting are adapted from Anton Piotukh (@antonp2k), [PR #39](https://github.com/rgcsekaraa/brows3/pull/39). The existing image viewer is retained rather than importing the older slider viewer.
