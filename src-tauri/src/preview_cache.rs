//! On-disk cache of previewed objects.
//!
//! Files mirror the remote layout under `files/<profile id>/<bucket>/<object key>`.
//! A copy is only reused while its size, modification time and ETag match the remote object.
//! The modification time of each cached file is set to the object's `LastModified`.

use crate::transfer::download::{DownloadDestination, PendingDownload};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const FILES_DIR: &str = "files";
const INDEX_FILE: &str = "index.json";
const TEMP_PREFIX: &str = ".brows3-";
const INDEX_VERSION: u32 = 1;
/// Partial downloads younger than this may still be in progress and are left alone on startup.
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

pub type PreviewCacheState = Arc<PreviewCache>;

/// The remote state a cached copy must match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectVersion {
    pub size: u64,
    /// Seconds since the Unix epoch (S3 `LastModified` has one-second precision).
    pub last_modified: i64,
    pub e_tag: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct IndexEntry {
    /// Exact relative path; the map key is its lowercase form so case-insensitive file systems
    /// cannot serve one key's copy for another key that differs only in case.
    path: String,
    #[serde(flatten)]
    version: ObjectVersion,
    accessed: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    version: u32,
    entries: HashMap<String, IndexEntry>,
}

struct Inner {
    dir: Arc<Dir>,
    index: Index,
}

pub struct PreviewCache {
    files_root: PathBuf,
    index_path: PathBuf,
    inner: Option<Mutex<Inner>>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct CacheUsage {
    pub files: u64,
    pub bytes: u64,
}

/// A cached object's location relative to the cache's file root, with `/` separators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachePath(String);

impl CachePath {
    pub fn new(profile_id: &str, bucket: &str, key: &str) -> Option<Self> {
        if profile_id.is_empty() || bucket.is_empty() || key.is_empty() {
            return None;
        }
        let mut path = format!("{}/{}", encode_segment(profile_id), encode_segment(bucket));
        for segment in key.split('/') {
            path.push('/');
            path.push_str(&encode_segment(segment));
        }
        Some(Self(path))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn index_key(&self) -> String {
        self.0.to_lowercase()
    }

    fn relative(&self) -> PathBuf {
        self.0.split('/').collect()
    }

    fn profile_prefix(profile_id: &str) -> String {
        format!("{}/", encode_segment(profile_id))
    }
}

fn is_windows_reserved(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// Encodes one key segment as a file name that is valid on Windows, macOS and Linux.
/// Safe names are kept as-is; the encoding is injective because `%` itself is always escaped.
pub fn encode_segment(segment: &str) -> String {
    match segment {
        "" => return "%".to_string(),
        "." => return "%2E".to_string(),
        ".." => return "%2E%2E".to_string(),
        _ => {}
    }
    let reserved = is_windows_reserved(segment);
    let temp_like = segment.starts_with(TEMP_PREFIX);
    let count = segment.chars().count();
    let mut out = String::with_capacity(segment.len());
    for (index, ch) in segment.chars().enumerate() {
        let last = index + 1 == count;
        let escape = matches!(
            ch,
            '%' | '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/'
        ) || ch.is_control()
            || (last && (ch == '.' || ch == ' '))
            || (index == 0 && (reserved || temp_like));
        if escape {
            let mut buffer = [0u8; 4];
            for byte in ch.encode_utf8(&mut buffer).bytes() {
                let _ = write!(out, "%{byte:02X}");
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn system_time_secs(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs() as i64,
        Err(before) => -(before.duration().as_secs_f64().ceil() as i64),
    }
}

pub fn secs_to_system_time(secs: i64) -> SystemTime {
    if secs >= 0 {
        UNIX_EPOCH + Duration::from_secs(secs as u64)
    } else {
        UNIX_EPOCH - Duration::from_secs(secs.unsigned_abs())
    }
}

fn unavailable() -> io::Error {
    io::Error::other("The local preview cache is unavailable")
}

impl Inner {
    fn entry(&self, path: &CachePath) -> Option<&IndexEntry> {
        self.index
            .entries
            .get(&path.index_key())
            .filter(|entry| entry.path == path.0)
    }

    /// True when the file on disk is a regular file with the entry's size and modification time.
    fn file_matches(&self, path: &CachePath, version: &ObjectVersion) -> bool {
        let Ok(metadata) = self.dir.symlink_metadata(path.relative()) else {
            return false;
        };
        let modified = metadata.modified().map(|time| time.into_std());
        metadata.is_file()
            && metadata.len() == version.size
            && modified.is_ok_and(|time| system_time_secs(time) == version.last_modified)
    }

    fn remove(&mut self, path: &CachePath) {
        if let Some(entry) = self.index.entries.remove(&path.index_key()) {
            remove_file_and_empty_parents(&self.dir, &entry.path);
        }
        remove_file_and_empty_parents(&self.dir, &path.0);
    }

    fn evict(&mut self, max_bytes: u64, keep: &str) {
        let mut total: u64 = self.index.entries.values().map(|e| e.version.size).sum();
        if total <= max_bytes {
            return;
        }
        let mut candidates: Vec<(i64, String)> = self
            .index
            .entries
            .iter()
            .filter(|(key, _)| key.as_str() != keep)
            .map(|(key, entry)| (entry.accessed, key.clone()))
            .collect();
        candidates.sort();
        for (_, key) in candidates {
            if total <= max_bytes {
                break;
            }
            if let Some(entry) = self.index.entries.remove(&key) {
                remove_file_and_empty_parents(&self.dir, &entry.path);
                total = total.saturating_sub(entry.version.size);
            }
        }
    }

    fn usage(&self) -> CacheUsage {
        CacheUsage {
            files: self.index.entries.len() as u64,
            bytes: self.index.entries.values().map(|e| e.version.size).sum(),
        }
    }
}

/// Removes a cached file and any directories it leaves empty, never the profile directory's parent.
fn remove_file_and_empty_parents(dir: &Dir, path: &str) {
    let relative: PathBuf = path.split('/').collect();
    match dir.remove_file(&relative) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            log::warn!("Could not remove cached preview {path}: {error}");
            return;
        }
    }
    let mut parent = relative.parent();
    while let Some(current) = parent.filter(|p| !p.as_os_str().is_empty()) {
        if dir.remove_dir(current).is_err() {
            break;
        }
        parent = current.parent();
    }
}

impl PreviewCache {
    /// Opens the cache at `root`. Failures leave the cache disabled so previews fall back to S3.
    pub fn open(root: PathBuf) -> Self {
        let files_root = root.join(FILES_DIR);
        let index_path = root.join(INDEX_FILE);
        let inner = std::fs::create_dir_all(&files_root)
            .and_then(|_| DownloadDestination::open_root(&files_root))
            .map(|dir| {
                let index = std::fs::read(&index_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Index>(&bytes).ok())
                    .filter(|index| index.version == INDEX_VERSION)
                    .unwrap_or(Index {
                        version: INDEX_VERSION,
                        entries: HashMap::new(),
                    });
                Mutex::new(Inner { dir, index })
            });
        match inner {
            Ok(inner) => Self {
                files_root,
                index_path,
                inner: Some(inner),
            },
            Err(error) => {
                log::error!("Local preview cache unavailable: {error}");
                Self {
                    files_root,
                    index_path,
                    inner: None,
                }
            }
        }
    }

    fn inner(&self) -> io::Result<&Mutex<Inner>> {
        self.inner.as_ref().ok_or_else(unavailable)
    }

    pub fn absolute(&self, path: &CachePath) -> PathBuf {
        self.files_root.join(path.relative())
    }

    fn persist(&self, inner: &Inner) {
        let result = serde_json::to_vec(&inner.index)
            .map_err(io::Error::other)
            .and_then(|bytes| {
                let temporary = self.index_path.with_extension("json.tmp");
                std::fs::write(&temporary, bytes)?;
                std::fs::rename(&temporary, &self.index_path)
            });
        if let Err(error) = result {
            log::warn!("Could not save the preview cache index: {error}");
        }
    }

    /// Returns the local copy when it matches the remote version exactly.
    pub async fn lookup(&self, path: &CachePath, remote: &ObjectVersion) -> Option<PathBuf> {
        let mut inner = self.inner().ok()?.lock().await;
        let matches = inner
            .entry(path)
            .is_some_and(|entry| &entry.version == remote)
            && inner.file_matches(path, remote);
        if !matches {
            return None;
        }
        if let Some(entry) = inner.index.entries.get_mut(&path.index_key()) {
            entry.accessed = now_secs();
        }
        Some(self.absolute(path))
    }

    /// Returns an intact local copy and the version it was saved from, without asking the remote.
    pub async fn offline_copy(&self, path: &CachePath) -> Option<(PathBuf, ObjectVersion)> {
        let inner = self.inner().ok()?.lock().await;
        let version = inner.entry(path)?.version.clone();
        inner
            .file_matches(path, &version)
            .then(|| (self.absolute(path), version))
    }

    #[cfg(test)]
    pub async fn version(&self, path: &CachePath) -> Option<ObjectVersion> {
        let inner = self.inner().ok()?.lock().await;
        inner.entry(path).map(|entry| entry.version.clone())
    }

    /// Starts writing a new copy into a temporary file next to its final location.
    pub async fn begin_fill(&self, path: &CachePath) -> io::Result<PendingDownload> {
        let dir = self.inner()?.lock().await.dir.clone();
        DownloadDestination::new(dir, path.relative(), true)?.begin()
    }

    /// Moves a fully written copy into place, records its version, and evicts old copies.
    pub async fn commit_fill(
        &self,
        path: &CachePath,
        pending: PendingDownload,
        version: ObjectVersion,
        max_bytes: u64,
    ) -> io::Result<PathBuf> {
        let mut inner = self.inner()?.lock().await;
        let key = path.index_key();
        if let Some(previous) = inner.index.entries.remove(&key) {
            if previous.path != path.0 {
                remove_file_and_empty_parents(&inner.dir, &previous.path);
            }
        }
        pending.commit()?;
        inner.index.entries.insert(
            key.clone(),
            IndexEntry {
                path: path.0.clone(),
                version,
                accessed: now_secs(),
            },
        );
        inner.evict(max_bytes, &key);
        self.persist(&inner);
        Ok(self.absolute(path))
    }

    pub async fn read(&self, path: &CachePath, max_bytes: u64) -> io::Result<Vec<u8>> {
        let inner = self.inner()?.lock().await;
        let metadata = inner.dir.symlink_metadata(path.relative())?;
        if !metadata.is_file() {
            return Err(io::Error::new(io::ErrorKind::NotFound, "No cached copy"));
        }
        if metadata.len() > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "The cached copy exceeds the preview limit",
            ));
        }
        inner.dir.read(path.relative())
    }

    pub async fn remove(&self, path: &CachePath) -> io::Result<()> {
        let mut inner = self.inner()?.lock().await;
        inner.remove(path);
        self.persist(&inner);
        Ok(())
    }

    pub async fn usage(&self) -> io::Result<CacheUsage> {
        Ok(self.inner()?.lock().await.usage())
    }

    /// Removes every cached file, or only those of one profile.
    pub async fn clear(&self, profile_id: Option<&str>) -> io::Result<()> {
        let mut inner = self.inner()?.lock().await;
        match profile_id {
            Some(profile_id) => {
                let prefix = CachePath::profile_prefix(profile_id);
                inner
                    .index
                    .entries
                    .retain(|_, entry| !entry.path.starts_with(&prefix));
                match inner.dir.remove_dir_all(encode_segment(profile_id)) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => {
                        log::warn!("Could not clear cached previews for a profile: {error}")
                    }
                    _ => {}
                }
            }
            None => {
                inner.index.entries.clear();
                for entry in inner.dir.entries()? {
                    let entry = entry?;
                    let name = entry.file_name();
                    let result = if entry.file_type()?.is_dir() {
                        inner.dir.remove_dir_all(&name)
                    } else {
                        inner.dir.remove_file(&name)
                    };
                    if let Err(error) = result {
                        log::warn!("Could not clear a cached preview: {error}");
                    }
                }
            }
        }
        self.persist(&inner);
        Ok(())
    }

    /// Drops index entries without intact files, and files and stale partial downloads without entries.
    pub async fn reconcile(&self) {
        let Ok(inner) = self.inner() else { return };
        let mut inner = inner.lock().await;
        let mut found = Vec::new();
        collect_files(&self.files_root, "", &mut found);
        let known: HashMap<String, String> = inner
            .index
            .entries
            .iter()
            .map(|(key, entry)| (entry.path.clone(), key.clone()))
            .collect();
        let cutoff = SystemTime::now() - STALE_TEMP_AGE;
        for (relative, modified) in &found {
            let name = relative.rsplit('/').next().unwrap_or(relative);
            let is_temporary = name.starts_with(TEMP_PREFIX) && name.ends_with(".part");
            let remove = if is_temporary {
                modified.is_some_and(|time| time < cutoff)
            } else {
                !known.contains_key(relative)
            };
            if remove {
                remove_file_and_empty_parents(&inner.dir, relative);
            }
        }
        let stale: Vec<String> = inner
            .index
            .entries
            .iter()
            .filter(|(_, entry)| {
                !inner.file_matches(&CachePath(entry.path.clone()), &entry.version)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            if let Some(entry) = inner.index.entries.remove(&key) {
                remove_file_and_empty_parents(&inner.dir, &entry.path);
            }
        }
        self.persist(&inner);
    }
}

/// Lists regular files and symlinks below `root` without following links.
fn collect_files(root: &Path, prefix: &str, found: &mut Vec<(String, Option<SystemTime>)>) {
    let Ok(entries) = std::fs::read_dir(root.join(prefix)) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(root, &relative, found);
        } else {
            let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
            found.push((relative, modified));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(size: u64, last_modified: i64, e_tag: &str) -> ObjectVersion {
        ObjectVersion {
            size,
            last_modified,
            e_tag: Some(e_tag.to_string()),
            content_type: Some("image/png".to_string()),
        }
    }

    async fn fill(
        cache: &PreviewCache,
        path: &CachePath,
        bytes: &[u8],
        v: &ObjectVersion,
        max: u64,
    ) -> PathBuf {
        let mut pending = cache.begin_fill(path).await.unwrap();
        pending.write_all(bytes).await.unwrap();
        pending
            .finish_writing_with_modified(Some(secs_to_system_time(v.last_modified)))
            .await
            .unwrap();
        cache
            .commit_fill(path, pending, v.clone(), max)
            .await
            .unwrap()
    }

    #[test]
    fn keys_mirror_the_remote_layout() {
        let path = CachePath::new("p1", "bucket", "photos/2024/a.jpg").unwrap();
        assert_eq!(path.as_str(), "p1/bucket/photos/2024/a.jpg");
        assert_eq!(
            path.relative(),
            PathBuf::from("p1/bucket/photos/2024/a.jpg")
        );
    }

    #[test]
    fn unsafe_segments_are_encoded_injectively() {
        assert_eq!(encode_segment(""), "%");
        assert_eq!(encode_segment("."), "%2E");
        assert_eq!(encode_segment(".."), "%2E%2E");
        assert_eq!(encode_segment("%"), "%25");
        assert_eq!(encode_segment("a:b?.txt"), "a%3Ab%3F.txt");
        assert_eq!(encode_segment("name. "), "name.%20");
        assert_eq!(encode_segment("trail."), "trail%2E");
        assert_eq!(encode_segment("CON"), "%43ON");
        assert_eq!(encode_segment("com1.txt"), "%63om1.txt");
        assert_eq!(encode_segment("console"), "console");
        assert_eq!(encode_segment(".brows3-x.part"), "%2Ebrows3-x.part");
        assert_eq!(encode_segment("tab\there"), "tab%09here");
        assert_eq!(encode_segment("фото.jpg"), "фото.jpg");
        let path = CachePath::new("p", "b", "a//../b/").unwrap();
        assert_eq!(path.as_str(), "p/b/a/%/%2E%2E/b/%");
        assert!(path
            .relative()
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_))));
    }

    #[tokio::test]
    async fn copies_are_reused_only_while_size_date_and_etag_match() {
        let root = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(root.path().to_path_buf());
        let path = CachePath::new("p", "b", "dir/a.png").unwrap();
        let v = version(3, 1_700_000_000, "\"e1\"");
        assert!(cache.lookup(&path, &v).await.is_none());

        let local = fill(&cache, &path, b"abc", &v, 1 << 20).await;
        assert_eq!(local, root.path().join("files/p/b/dir/a.png"));
        assert_eq!(std::fs::read(&local).unwrap(), b"abc");
        assert_eq!(cache.lookup(&path, &v).await, Some(local.clone()));

        assert!(cache
            .lookup(&path, &version(4, v.last_modified, "\"e1\""))
            .await
            .is_none());
        assert!(cache
            .lookup(&path, &version(3, v.last_modified + 1, "\"e1\""))
            .await
            .is_none());
        assert!(cache
            .lookup(&path, &version(3, v.last_modified, "\"e2\""))
            .await
            .is_none());

        // A copy changed on disk is not trusted even though the index still matches.
        std::fs::write(&local, b"abcd").unwrap();
        assert!(cache.lookup(&path, &v).await.is_none());
        assert!(cache.offline_copy(&path).await.is_none());
    }

    #[tokio::test]
    async fn index_survives_reopening_and_offline_copies_are_available() {
        let root = tempfile::tempdir().unwrap();
        let path = CachePath::new("p", "b", "a.txt").unwrap();
        let v = version(2, 1_600_000_000, "\"e\"");
        {
            let cache = PreviewCache::open(root.path().to_path_buf());
            fill(&cache, &path, b"hi", &v, 1 << 20).await;
        }
        let cache = PreviewCache::open(root.path().to_path_buf());
        let (local, cached) = cache.offline_copy(&path).await.unwrap();
        assert_eq!(cached, v);
        assert_eq!(std::fs::read(local).unwrap(), b"hi");
        assert_eq!(cache.read(&path, 10).await.unwrap(), b"hi");
        assert!(cache.read(&path, 1).await.is_err());
    }

    #[tokio::test]
    async fn keys_differing_only_in_case_never_share_a_copy() {
        let root = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(root.path().to_path_buf());
        let upper = CachePath::new("p", "b", "A.png").unwrap();
        let lower = CachePath::new("p", "b", "a.png").unwrap();
        let v = version(1, 1_700_000_000, "\"e\"");
        fill(&cache, &upper, b"A", &v, 1 << 20).await;
        fill(&cache, &lower, b"a", &v, 1 << 20).await;
        assert!(cache.lookup(&upper, &v).await.is_none());
        assert!(cache.lookup(&lower, &v).await.is_some());
    }

    #[tokio::test]
    async fn least_recently_used_copies_are_evicted_over_the_limit() {
        let root = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(root.path().to_path_buf());
        let paths: Vec<_> = ["a", "b", "c"]
            .iter()
            .map(|name| CachePath::new("p", "b", &format!("x/{name}")).unwrap())
            .collect();
        let v = version(4, 1_700_000_000, "\"e\"");
        fill(&cache, &paths[0], b"aaaa", &v, 10).await;
        fill(&cache, &paths[1], b"bbbb", &v, 10).await;
        {
            let mut inner = cache.inner().unwrap().lock().await;
            inner
                .index
                .entries
                .get_mut(&paths[0].index_key())
                .unwrap()
                .accessed = 1;
        }
        fill(&cache, &paths[2], b"cccc", &v, 10).await;
        assert!(cache.lookup(&paths[0], &v).await.is_none());
        assert!(cache.lookup(&paths[1], &v).await.is_some());
        assert!(cache.lookup(&paths[2], &v).await.is_some());
        assert_eq!(cache.usage().await.unwrap().bytes, 8);
    }

    #[tokio::test]
    async fn removing_and_clearing_prunes_files_and_empty_folders() {
        let root = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(root.path().to_path_buf());
        let v = version(1, 1_700_000_000, "\"e\"");
        let one = CachePath::new("p1", "b", "deep/nested/a").unwrap();
        let two = CachePath::new("p2", "b", "b").unwrap();
        fill(&cache, &one, b"1", &v, 1 << 20).await;
        fill(&cache, &two, b"2", &v, 1 << 20).await;
        cache.remove(&one).await.unwrap();
        assert!(!root.path().join("files/p1").exists());
        fill(&cache, &one, b"1", &v, 1 << 20).await;
        cache.clear(Some("p1")).await.unwrap();
        assert!(cache.lookup(&one, &v).await.is_none());
        assert!(cache.lookup(&two, &v).await.is_some());
        cache.clear(None).await.unwrap();
        assert_eq!(cache.usage().await.unwrap().files, 0);
        assert!(std::fs::read_dir(root.path().join("files"))
            .unwrap()
            .next()
            .is_none());
    }

    #[tokio::test]
    async fn reconcile_removes_orphans_and_missing_entries() {
        let root = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(root.path().to_path_buf());
        let v = version(1, 1_700_000_000, "\"e\"");
        let kept = CachePath::new("p", "b", "kept").unwrap();
        let lost = CachePath::new("p", "b", "lost").unwrap();
        fill(&cache, &kept, b"k", &v, 1 << 20).await;
        fill(&cache, &lost, b"l", &v, 1 << 20).await;
        std::fs::remove_file(cache.absolute(&lost)).unwrap();
        std::fs::write(root.path().join("files/p/b/orphan"), b"o").unwrap();
        let fresh_temp = root.path().join("files/p/b/.brows3-new.part");
        std::fs::write(&fresh_temp, b"t").unwrap();
        cache.reconcile().await;
        assert!(cache.lookup(&kept, &v).await.is_some());
        assert!(cache.version(&lost).await.is_none());
        assert!(!root.path().join("files/p/b/orphan").exists());
        assert!(fresh_temp.exists(), "in-progress downloads are kept");
    }

    #[tokio::test]
    async fn an_object_cannot_replace_a_cached_folder() {
        let root = tempfile::tempdir().unwrap();
        let cache = PreviewCache::open(root.path().to_path_buf());
        let v = version(1, 1_700_000_000, "\"e\"");
        fill(
            &cache,
            &CachePath::new("p", "b", "photos/a").unwrap(),
            b"a",
            &v,
            1 << 20,
        )
        .await;
        let folder_named = CachePath::new("p", "b", "photos").unwrap();
        let mut pending = cache.begin_fill(&folder_named).await.unwrap();
        pending.write_all(b"x").await.unwrap();
        pending.finish_writing().await.unwrap();
        assert!(cache
            .commit_fill(&folder_named, pending, v, 1 << 20)
            .await
            .is_err());
    }
}
