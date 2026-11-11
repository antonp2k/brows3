'use client';

import { useState, useEffect } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  List, 
  ListItem, 
  ListItemText, 
  ListItemIcon,
  ListItemSecondaryAction, 
  Select, 
  MenuItem, 
  TextField, 
  Slider, 
  Switch,
  Container,
  Button,
  Chip,
  Divider,
  Alert,
} from '@mui/material';
import {
  Update as UpdateIcon,
  Folder as FolderIcon,
  DeleteSweep as ClearIcon,
  MonitorHeart as MonitorIcon,
  CheckCircle as SuccessIcon,
  ErrorOutline as ErrorIcon,
  Info as InfoIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import {
  MAX_TEXT_PREVIEW_SIZE_MB,
  MIN_TEXT_PREVIEW_SIZE_MB,
  MAX_LOCAL_CACHE_MB,
  MIN_LOCAL_CACHE_MB,
  useSettingsStore,
} from '@/store/settingsStore';
import { useAppStore } from '@/store/appStore';
import { useMonitorStore } from '@/store/monitorStore';
import { invalidateBucketCache } from '@/hooks/useBuckets';
import { toast } from '@/store/toastStore';
import { bucketApi, copyToClipboard, invalidateCache, isTauri, logApi, previewCacheApi, transferApi, type LogFileInfo } from '@/lib/tauri';
import { previewCache } from '@/lib/previewPrefetch';

export default function SettingsPage() {
  // Theme is controlled by appStore (used by the actual app)
  const { themeMode, setThemeMode, clearDiscoveredRegions } = useAppStore();
  // Other settings from settingsStore
  const { 
    defaultRegion, setDefaultRegion, 
    maxConcurrentTransfers, setMaxConcurrentTransfers,
    transferBandwidthKiB, setTransferBandwidthKiB,
    maxTextPreviewSizeMb, setMaxTextPreviewSizeMb,
    autoRefreshOnFocus, setAutoRefreshOnFocus,
    localCacheEnabled, setLocalCacheEnabled,
    localCacheMaxMb, setLocalCacheMaxMb,
  } = useSettingsStore();
  const [pendingCacheLimit, setPendingCacheLimit] = useState(localCacheMaxMb);
  const [cacheUsage, setCacheUsage] = useState<{ files: number; bytes: number } | null>(null);
  const [clearingLocalCache, setClearingLocalCache] = useState(false);
  const refreshCacheUsage = () => {
    if (!isTauri()) return;
    previewCacheApi.usage().then(setCacheUsage).catch(() => setCacheUsage(null));
  };
  useEffect(refreshCacheUsage, []);
  useEffect(() => { setPendingCacheLimit(localCacheMaxMb); }, [localCacheMaxMb]);
  const handleClearLocalCache = async () => {
    setClearingLocalCache(true);
    try {
      await previewCacheApi.clear();
      previewCache.clear();
      toast.success('Local cache cleared', 'Previews will be downloaded again when opened.');
    } catch (error) {
      toast.error('Could not clear the local cache', String(error));
    } finally {
      setClearingLocalCache(false);
      refreshCacheUsage();
    }
  };
  
  const [version, setVersion] = useState<string>('...');
  const [appDataDir, setAppDataDir] = useState<string>('Loading...');
  const [logFileInfo, setLogFileInfo] = useState<LogFileInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [pendingTransferConcurrency, setPendingTransferConcurrency] = useState(maxConcurrentTransfers);
  const [pendingPreviewLimit, setPendingPreviewLimit] = useState(maxTextPreviewSizeMb);
  const [bandwidth, setBandwidth] = useState(String(transferBandwidthKiB));
  const [savingBandwidth, setSavingBandwidth] = useState(false);
  const [bandwidthError, setBandwidthError] = useState('');
  const bandwidthValue = Number(bandwidth);
  const validBandwidth = /^\d+$/.test(bandwidth) && Number.isSafeInteger(bandwidthValue) && (bandwidthValue === 0 || (bandwidthValue >= 64 && bandwidthValue <= 1048576));
  useEffect(() => { setBandwidth(String(transferBandwidthKiB)); }, [transferBandwidthKiB]);
  async function applyBandwidth() {
    if (!validBandwidth || savingBandwidth) return;
    setSavingBandwidth(true); setBandwidthError('');
    try {
      if (isTauri()) await transferApi.setBandwidth(bandwidthValue * 1024);
      setTransferBandwidthKiB(bandwidthValue);
      toast.success('Bandwidth limit saved', 'Applies to newly queued transfers. Existing jobs keep their limit.');
    } catch (e) { setBandwidthError(String(e)); }
    finally { setSavingBandwidth(false); }
  }
  
  useEffect(() => {
    if (!isTauri()) {
      setVersion('Web');
      setAppDataDir('Desktop app only');
      return;
    }

    // Get app version
    import('@tauri-apps/api/app').then(({ getVersion }) => {
      getVersion().then(setVersion).catch(() => setVersion('Unknown'));
    });
    
    // Get app data directory
    import('@tauri-apps/api/path').then(({ appDataDir: getAppDataDir }) => {
      getAppDataDir().then(setAppDataDir).catch(() => setAppDataDir('Unknown'));
    });

    logApi.getLogFileInfo()
      .then(setLogFileInfo)
      .catch(() => setLogFileInfo(null));
  }, []);

  useEffect(() => {
    setPendingTransferConcurrency(maxConcurrentTransfers);
  }, [maxConcurrentTransfers]);

  useEffect(() => {
    setPendingPreviewLimit(maxTextPreviewSizeMb);
  }, [maxTextPreviewSizeMb]);

  const handleClearCache = async () => {
    try {
      if (isTauri()) await bucketApi.refreshS3Client();
      invalidateBucketCache();
      clearDiscoveredRegions();
      invalidateCache();
      toast.success('Caches cleared', 'Bucket lists, discovered regions, and object views were reset.');
    } catch (error) {
      toast.error('Could not clear caches', String(error));
    }
  };

  const handleCheckUpdate = async () => {
    if (!isTauri()) {
      toast.info('Desktop only', 'Update checks are only available in the desktop app.');
      return;
    }

    setIsCheckingUpdate(true);
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        toast.success('Update available', `Version ${update.version} is available. It will install automatically.`);
        await update.downloadAndInstall();
      } else {
        toast.info('Up to date', 'You are running the latest version.');
      }
    } catch (err) {
      toast.error('Update check failed', String(err));
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleCopyLogPath = async () => {
    if (!logFileInfo) return;

    try {
      await copyToClipboard(logFileInfo.log_file_path);
      toast.success('Log path copied');
    } catch (err) {
      toast.error('Copy failed', String(err));
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 4 }}>
        <Typography variant="h4">Settings</Typography>
        <Chip label={`v${version}`} size="small" variant="outlined" />
      </Box>

      {/* Appearance Section */}
      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" fontWeight={600}>Appearance</Typography>
        </Box>
        <List>
          <ListItem>
            <ListItemText 
              primary="Theme" 
              secondary="Choose your preferred interface appearance" 
            />
            <ListItemSecondaryAction>
              <Select
                size="small"
                value={themeMode}
                onChange={(e) => {
                  setThemeMode(e.target.value as 'light' | 'dark' | 'system');
                  toast.success('Theme updated', `Changed to ${e.target.value} mode`);
                }}
                sx={{ minWidth: 120 }}
              >
                <MenuItem value="light">Light</MenuItem>
                <MenuItem value="dark">Dark</MenuItem>
                <MenuItem value="system">System</MenuItem>
              </Select>
            </ListItemSecondaryAction>
          </ListItem>
        </List>
      </Paper>

      {/* Defaults Section */}
      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" fontWeight={600}>Defaults</Typography>
        </Box>
        <List>
          <ListItem>
            <ListItemText 
              primary="Default Region" 
              secondary="Used as fallback for new profiles if region cannot be auto-detected" 
            />
            <ListItemSecondaryAction>
              <TextField 
                size="small" 
                variant="outlined" 
                value={defaultRegion} 
                onChange={(e) => setDefaultRegion(e.target.value)}
                sx={{ width: 150 }}
              />
            </ListItemSecondaryAction>
          </ListItem>
        </List>
      </Paper>

      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" fontWeight={600}>Performance & Behavior</Typography>
        </Box>
        <List>
          <ListItem divider>
            <ListItemText 
              primary="Max Concurrent Transfers" 
              secondary={`Allow up to ${pendingTransferConcurrency} simultaneous uploads/downloads`} 
            />
            <Box sx={{ width: 200, mr: 2 }}>
               <Slider
                 value={pendingTransferConcurrency}
                 min={1}
                 max={20}
                 step={1}
                 valueLabelDisplay="auto"
                 onChange={(_, val) => setPendingTransferConcurrency(val as number)}
                 onChangeCommitted={(_, val) => {
                   const nextValue = val as number;
                   setPendingTransferConcurrency(nextValue);
                   if (nextValue !== maxConcurrentTransfers) {
                     setMaxConcurrentTransfers(nextValue);
                     toast.success('Transfer concurrency updated', `Set to ${nextValue}`);
                   }
                 }}
               />
            </Box>
          </ListItem>
          <ListItem divider sx={{ flexDirection: 'column', alignItems: 'stretch', gap: 1 }}>
            <ListItemText primary="Bandwidth per transfer" secondary="Limits each newly queued upload or download, including sync, cross-profile copy and restore. Existing jobs keep their limit. Concurrent jobs each get this allowance; this is not a total app limit." />
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              <TextField label="Limit (KiB/s)" size="small" value={bandwidth} disabled={savingBandwidth} onChange={e => { setBandwidth(e.target.value); setBandwidthError(''); }} inputProps={{ inputMode: 'numeric' }} error={!validBandwidth} helperText="0 is unlimited. Otherwise 64 to 1,048,576 KiB/s." sx={{ flex: 1 }} />
              <Button size="small" variant="outlined" sx={{ borderRadius: '999px', color: 'text.primary', mt: 0.5 }} disabled={!validBandwidth || savingBandwidth || bandwidthValue === transferBandwidthKiB} onClick={applyBandwidth}>{savingBandwidth ? 'Saving...' : 'Apply'}</Button>
            </Box>
            {bandwidthError && <Alert severity="error">{bandwidthError}</Alert>}
          </ListItem>
          <ListItem divider>
            <ListItemText
              primary="Text Preview Size Limit"
              secondary={`Load text, HTML, and code objects up to ${pendingPreviewLimit} MB. Audio and video are streamed; images and PDFs do not use this memory limit.`}
            />
            <Box sx={{ width: 200, mr: 2 }}>
              <Slider
                value={pendingPreviewLimit}
                min={MIN_TEXT_PREVIEW_SIZE_MB}
                max={MAX_TEXT_PREVIEW_SIZE_MB}
                step={1}
                valueLabelDisplay="auto"
                valueLabelFormat={(value) => `${value} MB`}
                onChange={(_, value) => setPendingPreviewLimit(value as number)}
                onChangeCommitted={(_, value) => {
                  const nextValue = value as number;
                  setPendingPreviewLimit(nextValue);
                  if (nextValue !== maxTextPreviewSizeMb) {
                    setMaxTextPreviewSizeMb(nextValue);
                    toast.success('Preview limit updated', `Text previews can use up to ${nextValue} MB`);
                  }
                }}
              />
            </Box>
          </ListItem>
          <ListItem divider>
            <ListItemText
              primary="Local Preview Cache"
              secondary="Keep previewed and prefetched images, PDFs and text files on disk. A copy is reused only while its size, date and ETag match the remote object; offline, the last copy is shown with a label."
            />
            <ListItemSecondaryAction>
              <Switch
                edge="end"
                checked={localCacheEnabled}
                inputProps={{ 'aria-label': 'Local preview cache' }}
                onChange={(e) => {
                  setLocalCacheEnabled(e.target.checked);
                  previewCache.clear();
                  toast.success('Local cache updated', `Local preview cache ${e.target.checked ? 'enabled' : 'disabled'}`);
                }}
              />
            </ListItemSecondaryAction>
          </ListItem>
          <ListItem divider>
            <ListItemText
              primary="Local Cache Size Limit"
              secondary={`Least recently used copies are removed above ${pendingCacheLimit >= 1024 ? `${(pendingCacheLimit / 1024).toFixed(1)} GB` : `${pendingCacheLimit} MB`}. In use: ${cacheUsage ? `${(cacheUsage.bytes / 1024 / 1024).toFixed(1)} MB in ${cacheUsage.files} files` : 'unknown'}.`}
            />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mr: 2 }}>
              <Slider
                sx={{ width: 160 }}
                value={pendingCacheLimit}
                min={MIN_LOCAL_CACHE_MB}
                max={MAX_LOCAL_CACHE_MB}
                step={100}
                valueLabelDisplay="auto"
                valueLabelFormat={(value) => `${value} MB`}
                onChange={(_, value) => setPendingCacheLimit(value as number)}
                onChangeCommitted={(_, value) => {
                  const nextValue = value as number;
                  setPendingCacheLimit(nextValue);
                  if (nextValue !== localCacheMaxMb) setLocalCacheMaxMb(nextValue);
                }}
              />
              <Button size="small" variant="outlined" sx={{ borderRadius: '999px', color: 'text.primary', whiteSpace: 'nowrap' }} disabled={!isTauri() || clearingLocalCache} onClick={handleClearLocalCache}>
                {clearingLocalCache ? 'Clearing...' : 'Clear'}
              </Button>
            </Box>
          </ListItem>
          <ListItem>
            <ListItemText 
              primary="Auto-refresh on Focus" 
              secondary="Automatically refresh object list when returning to the app" 
            />
            <ListItemSecondaryAction>
              <Switch
                edge="end"
                checked={autoRefreshOnFocus}
                onChange={(e) => {
                  setAutoRefreshOnFocus(e.target.checked);
                  toast.success('Behavior updated', `Auto-refresh ${e.target.checked ? 'enabled' : 'disabled'}`);
                }}
              />
            </ListItemSecondaryAction>
          </ListItem>
        </List>
      </Paper>

      {/* Data & Storage Section */}
      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" fontWeight={600}>Data & Storage</Typography>
        </Box>
        <List>
          <ListItem>
            <ListItemIcon>
              <FolderIcon color="action" />
            </ListItemIcon>
            <ListItemText 
              primary="App Data Location" 
              secondary={appDataDir}
              secondaryTypographyProps={{ 
                component: 'code', 
                sx: { fontSize: '0.75rem', bgcolor: 'action.hover', px: 1, py: 0.5, borderRadius: 1, display: 'inline-block', mt: 0.5 } 
              }}
            />
          </ListItem>
          <Divider />
          <ListItem>
            <ListItemIcon>
              <InfoIcon color="action" />
            </ListItemIcon>
            <ListItemText
              primary="Diagnostic Log File"
              secondary={logFileInfo?.log_file_path || (isTauri() ? 'Unavailable' : 'Desktop app only')}
              secondaryTypographyProps={{
                component: 'code',
                sx: { fontSize: '0.75rem', bgcolor: 'action.hover', px: 1, py: 0.5, borderRadius: 1, display: 'inline-block', mt: 0.5, maxWidth: '100%', overflowWrap: 'anywhere' }
              }}
            />
            <ListItemSecondaryAction sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CopyIcon />}
                disabled={!logFileInfo}
                onClick={handleCopyLogPath}
              >
                Copy Path
              </Button>
            </ListItemSecondaryAction>
          </ListItem>
          <Divider />
          {logFileInfo?.panic_log_exists && (
            <>
              <ListItem>
                <ListItemIcon>
                  <ErrorIcon color="error" />
                </ListItemIcon>
                <ListItemText
                  primary="Last Panic Log"
                  secondary={logFileInfo.panic_log_path}
                  secondaryTypographyProps={{
                    component: 'code',
                    sx: { fontSize: '0.75rem', bgcolor: 'action.hover', px: 1, py: 0.5, borderRadius: 1, display: 'inline-block', mt: 0.5, maxWidth: '100%', overflowWrap: 'anywhere' }
                  }}
                />
              </ListItem>
              <Divider />
            </>
          )}
          <ListItem>
            <ListItemText 
              primary="Cached Bucket and Object Data" 
              secondary="Clear cached bucket lists, discovered regions, and open object views to force fresh fetches from S3" 
            />
            <ListItemSecondaryAction>
              <Button 
                variant="outlined" 
                size="small" 
                startIcon={<ClearIcon />}
                onClick={handleClearCache}
              >
                Clear Cache
              </Button>
            </ListItemSecondaryAction>
          </ListItem>
        </List>
      </Paper>

      {/* Updates Section */}
      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Box sx={{ p: 2, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle1" fontWeight={600}>Updates</Typography>
        </Box>
        <List>
          <ListItem>
            <ListItemText 
              primary="Check for Updates" 
              secondary="Manually check if a newer version is available" 
            />
            <ListItemSecondaryAction>
              <Button 
                variant="contained" 
                size="small" 
                startIcon={<UpdateIcon />}
                onClick={handleCheckUpdate}
                disabled={isCheckingUpdate}
              >
                {isCheckingUpdate ? 'Checking...' : 'Check Now'}
              </Button>
            </ListItemSecondaryAction>
          </ListItem>
        </List>
        <Alert severity="info" sx={{ m: 2, mt: 0 }}>
          Brows3 automatically checks for updates on startup. Updates are signed and verified before installation.
        </Alert>
      </Paper>

      {/* System Monitor Section */}
      <SystemMonitor />
    </Container>
  );
}

function SystemMonitor() {
  const { logs, metrics, clearLogs } = useMonitorStore();
  
  return (
    <Paper variant="outlined">
        <Box sx={{ p: 2, bgcolor: 'action.hover', borderBottom: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <MonitorIcon color="primary" />
            <Typography variant="subtitle1" fontWeight={600}>System Monitor</Typography>
          </Box>
          <Button size="small" onClick={clearLogs} startIcon={<ClearIcon />}>Clear Logs</Button>
        </Box>
        
        <Box sx={{ p: 2, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                <Typography variant="h4" color="primary">{metrics.totalRequests}</Typography>
                <Typography variant="caption" color="text.secondary">Total Requests</Typography>
            </Paper>
            <Paper variant="outlined" sx={{ p: 2, textAlign: 'center' }}>
                <Typography variant="h4" color={metrics.failedRequests > 0 ? "error" : "text.secondary"}>
                    {metrics.failedRequests}
                </Typography>
                <Typography variant="caption" color="text.secondary">Failed Requests</Typography>
            </Paper>
        </Box>

        <Box sx={{ maxHeight: 300, overflow: 'auto', borderTop: 1, borderColor: 'divider' }}>
            {logs.length === 0 ? (
                <Typography sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>No logs yet</Typography>
            ) : (
                <List dense>
                    {logs.map((log) => (
                        <ListItem key={log.id} divider>
                            <ListItemIcon sx={{ minWidth: 36 }}>
                                {log.type === 'error' ? <ErrorIcon color="error" fontSize="small" /> : 
                                 log.type === 'success' ? <SuccessIcon color="success" fontSize="small" /> :
                                 <InfoIcon color="info" fontSize="small" />}
                            </ListItemIcon>
                            <ListItemText 
                                primary={
                                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <Typography variant="body2" component="span" sx={{ fontFamily: 'monospace' }}>{log.message}</Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            {new Date(log.timestamp).toLocaleTimeString()}
                                        </Typography>
                                    </Box>
                                }
                                secondary={log.details}
                                secondaryTypographyProps={{ 
                                    sx: { 
                                        color: 'error.main', 
                                        fontFamily: 'monospace', 
                                        fontSize: '0.75rem',
                                        mt: 0.5 
                                    } 
                                }}
                            />
                        </ListItem>
                    ))}
                </List>
            )}
        </Box>
    </Paper>
  );
}
