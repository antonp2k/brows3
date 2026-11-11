use crate::commands::profiles::ProfileState;
use crate::credentials::Profile;
use crate::error::{AppError, Result};
use crate::preview_cache::{
    secs_to_system_time, CachePath, CacheUsage, ObjectVersion, PreviewCacheState,
};
use crate::s3::S3State;
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::head_object::{HeadObjectError, HeadObjectOutput};
use aws_sdk_s3::Client;
use serde::Serialize;
use tauri::State;

/// What the preview needs to know about an object, and where its local copy is when one can be used.
#[derive(Debug, Serialize)]
pub struct PreviewCacheLookup {
    pub profile_id: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub e_tag: Option<String>,
    /// A local copy matching the remote object, or the last saved copy when `offline`.
    pub local_path: Option<String>,
    /// The remote could not be reached; the metadata and copy come from the cache.
    pub offline: bool,
    /// The remote has no `LastModified`, so a copy could not be validated and is not saved.
    pub cacheable: bool,
}

enum Head {
    Found(Box<HeadObjectOutput>),
    NotFound,
    Unreachable(String),
}

async fn active_profile(
    profile_state: &ProfileState,
    expected_profile_id: &str,
) -> Result<Profile> {
    let manager = profile_state.read().await;
    let profile = manager
        .get_active_profile()
        .await?
        .ok_or_else(|| AppError::ProfileNotFound("No active profile".into()))?;
    drop(manager);
    super::operations::validate_operation_profile(Some(expected_profile_id), &profile.id)?;
    Ok(profile)
}

async fn client_for(
    profile: &Profile,
    bucket: &str,
    region_hint: Option<String>,
    s3_state: &S3State,
) -> Result<Client> {
    let region = {
        let manager = s3_state.read().await;
        manager.get_bucket_region(profile, bucket)
    }
    .or(region_hint);
    let mut manager = s3_state.write().await;
    Ok(match region {
        Some(region) => manager
            .get_client_for_region(profile, &region)
            .await?
            .clone(),
        None => manager.get_client(profile).await?.clone(),
    })
}

#[allow(clippy::result_large_err)] // The error is only inspected, never propagated.
fn classify(
    error: SdkError<HeadObjectError>,
) -> std::result::Result<Head, SdkError<HeadObjectError>> {
    match &error {
        SdkError::ServiceError(service) if service.err().is_not_found() => Ok(Head::NotFound),
        SdkError::ServiceError(_) => Err(error),
        // Network, timeout, credential resolution and malformed responses: the remote is unreachable.
        _ => Ok(Head::Unreachable(error.to_string())),
    }
}

async fn head(
    profile: &Profile,
    bucket: &str,
    region_hint: Option<String>,
    key: &str,
    s3_state: &S3State,
) -> Result<Head> {
    let client = client_for(profile, bucket, region_hint, s3_state).await?;
    let error = match client.head_object().bucket(bucket).key(key).send().await {
        Ok(output) => return Ok(Head::Found(Box::new(output))),
        Err(error) => match classify(error) {
            Ok(head) => return Ok(head),
            Err(error) => error,
        },
    };
    if error.raw_response().map(|r| r.status().as_u16()) == Some(403) {
        return Err(AppError::AccessDenied(error.to_string()));
    }

    // Probably a region mismatch; discover the bucket's region and try once more.
    log::warn!("Preview cache head_object failed, attempting region discovery: {error}");
    let discovery_client = {
        let mut manager = s3_state.write().await;
        manager.get_client(profile).await?.clone()
    };
    let Some(region) = crate::s3::get_bucket_region(&discovery_client, bucket)
        .await
        .ok()
    else {
        return Err(AppError::S3Error(error.to_string()));
    };
    let client = {
        let mut manager = s3_state.write().await;
        manager.set_bucket_region(profile, bucket, region.clone());
        manager
            .get_client_for_region(profile, &region)
            .await?
            .clone()
    };
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(output) => Ok(Head::Found(Box::new(output))),
        Err(error) => classify(error).map_err(|error| {
            if error.raw_response().map(|r| r.status().as_u16()) == Some(403) {
                AppError::AccessDenied(error.to_string())
            } else {
                AppError::S3Error(error.to_string())
            }
        }),
    }
}

fn cache_path(profile_id: &str, bucket: &str, key: &str) -> Result<CachePath> {
    CachePath::new(profile_id, bucket, key)
        .ok_or_else(|| AppError::ConfigError("This object cannot be cached locally".into()))
}

fn format_secs(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Asks the remote for the object's current version and returns the local copy if it still matches.
/// When the remote cannot be reached, returns the last saved copy marked `offline`.
#[tauri::command]
pub async fn preview_cache_lookup(
    bucket_name: String,
    bucket_region: Option<String>,
    key: String,
    expected_profile_id: String,
    profile_state: State<'_, ProfileState>,
    s3_state: State<'_, S3State>,
    cache: State<'_, PreviewCacheState>,
) -> Result<PreviewCacheLookup> {
    let profile = active_profile(&profile_state, &expected_profile_id).await?;
    let path = cache_path(&profile.id, &bucket_name, &key)?;
    match head(&profile, &bucket_name, bucket_region, &key, &s3_state).await? {
        Head::Found(output) => {
            let size = output
                .content_length()
                .and_then(|n| u64::try_from(n).ok())
                .unwrap_or(0);
            let last_modified = output.last_modified().map(|time| time.secs());
            let version = last_modified.map(|last_modified| ObjectVersion {
                size,
                last_modified,
                e_tag: output.e_tag().map(str::to_string),
                content_type: output.content_type().map(str::to_string),
            });
            let local_path = match &version {
                Some(version) => cache.lookup(&path, version).await,
                None => None,
            };
            Ok(PreviewCacheLookup {
                profile_id: profile.id,
                size,
                last_modified: output.last_modified().map(|time| time.to_string()),
                content_type: output.content_type().map(str::to_string),
                e_tag: output.e_tag().map(str::to_string),
                local_path: local_path.map(|p| p.to_string_lossy().into_owned()),
                offline: false,
                cacheable: version.is_some(),
            })
        }
        Head::NotFound => {
            if let Err(error) = cache.remove(&path).await {
                log::warn!("Could not remove a deleted object's cached copy: {error}");
            }
            Err(AppError::S3Error("The object no longer exists.".into()))
        }
        Head::Unreachable(message) => {
            let Some((local, version)) = cache.offline_copy(&path).await else {
                return Err(AppError::ConnectionFailed(message));
            };
            log::warn!("Remote unreachable, showing the cached copy: {message}");
            Ok(PreviewCacheLookup {
                profile_id: profile.id,
                size: version.size,
                last_modified: format_secs(version.last_modified),
                content_type: version.content_type,
                e_tag: version.e_tag,
                local_path: Some(local.to_string_lossy().into_owned()),
                offline: true,
                cacheable: true,
            })
        }
    }
}

/// Downloads the object version identified by `e_tag` and `size` into the cache.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_cache_fill(
    bucket_name: String,
    bucket_region: Option<String>,
    key: String,
    e_tag: Option<String>,
    size: u64,
    max_cache_bytes: u64,
    expected_profile_id: String,
    profile_state: State<'_, ProfileState>,
    s3_state: State<'_, S3State>,
    cache: State<'_, PreviewCacheState>,
) -> Result<String> {
    if size > max_cache_bytes {
        return Err(AppError::ConfigError(
            "The object is larger than the local cache".into(),
        ));
    }
    let profile = active_profile(&profile_state, &expected_profile_id).await?;
    let path = cache_path(&profile.id, &bucket_name, &key)?;
    let client = client_for(&profile, &bucket_name, bucket_region, &s3_state).await?;
    let mut request = client.get_object().bucket(&bucket_name).key(&key);
    if let Some(e_tag) = &e_tag {
        // The copy must be exactly the version the preview validated against.
        request = request.if_match(e_tag);
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::S3Error(e.to_string()))?;
    let last_modified = response
        .last_modified()
        .map(|time| time.secs())
        .ok_or_else(|| AppError::S3Error("The object has no modification date".into()))?;
    let version = ObjectVersion {
        size,
        last_modified,
        e_tag: response.e_tag().map(str::to_string).or(e_tag),
        content_type: response.content_type().map(str::to_string),
    };

    let mut pending = cache.begin_fill(&path).await?;
    let mut body = response.body;
    let mut written: u64 = 0;
    while let Some(chunk) = body
        .try_next()
        .await
        .map_err(|e| AppError::S3Error(e.to_string()))?
    {
        written += chunk.len() as u64;
        if written > size {
            return Err(AppError::S3Error(
                "The object changed while it was being cached".into(),
            ));
        }
        pending.write_all(&chunk).await?;
    }
    if written != size {
        return Err(AppError::S3Error(
            "The object changed while it was being cached".into(),
        ));
    }
    pending
        .finish_writing_with_modified(Some(secs_to_system_time(last_modified)))
        .await?;
    let local = cache
        .commit_fill(&path, pending, version, max_cache_bytes)
        .await?;
    Ok(local.to_string_lossy().into_owned())
}

/// Reads a cached copy as text with the same checks as remote text previews.
#[tauri::command]
pub async fn preview_cache_read_text(
    bucket_name: String,
    key: String,
    max_bytes: Option<u64>,
    expected_profile_id: String,
    profile_state: State<'_, ProfileState>,
    cache: State<'_, PreviewCacheState>,
) -> Result<String> {
    let profile = active_profile(&profile_state, &expected_profile_id).await?;
    let path = cache_path(&profile.id, &bucket_name, &key)?;
    let max_bytes = super::objects::normalized_text_preview_limit(max_bytes);
    let bytes = cache.read(&path, max_bytes).await?;
    super::objects::decode_preview_text(bytes)
}

#[tauri::command]
pub async fn preview_cache_remove(
    bucket_name: String,
    key: String,
    expected_profile_id: String,
    profile_state: State<'_, ProfileState>,
    cache: State<'_, PreviewCacheState>,
) -> Result<()> {
    let profile = active_profile(&profile_state, &expected_profile_id).await?;
    cache
        .remove(&cache_path(&profile.id, &bucket_name, &key)?)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn preview_cache_usage(cache: State<'_, PreviewCacheState>) -> Result<CacheUsage> {
    Ok(cache.usage().await?)
}

#[tauri::command]
pub async fn clear_preview_cache(cache: State<'_, PreviewCacheState>) -> Result<()> {
    Ok(cache.clear(None).await?)
}
