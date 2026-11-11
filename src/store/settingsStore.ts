import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { browserStorage } from './browserStorage';

export const MIN_TEXT_PREVIEW_SIZE_MB = 1;
export const MAX_TEXT_PREVIEW_SIZE_MB = 100;
export const MIN_LOCAL_CACHE_MB = 100;
export const MAX_LOCAL_CACHE_MB = 20480;

interface SettingsState {
  defaultRegion: string;
  maxConcurrentTransfers: number;
  transferBandwidthKiB: number;
  setTransferBandwidthKiB: (value: number) => void;
  maxTextPreviewSizeMb: number;
  autoRefreshOnFocus: boolean;
  /** Keep previewed images, PDFs and text on disk and reuse them while they match the remote. */
  localCacheEnabled: boolean;
  localCacheMaxMb: number;
  setLocalCacheEnabled: (enabled: boolean) => void;
  setLocalCacheMaxMb: (max: number) => void;
  setDefaultRegion: (region: string) => void;
  setMaxConcurrentTransfers: (max: number) => void;
  setMaxTextPreviewSizeMb: (max: number) => void;
  setAutoRefreshOnFocus: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultRegion: 'us-east-1',
      maxConcurrentTransfers: 5,
      transferBandwidthKiB: 0,
      setTransferBandwidthKiB: (value) => { if (Number.isInteger(value) && (value === 0 || (value >= 64 && value <= 1048576))) set({ transferBandwidthKiB: value }); },
      maxTextPreviewSizeMb: 2,
      autoRefreshOnFocus: false, // Disabled by default - can cause freezing on Ubuntu
      setDefaultRegion: (defaultRegion) => set({ defaultRegion }),
      setMaxConcurrentTransfers: (maxConcurrentTransfers) => set({ maxConcurrentTransfers }),
      setMaxTextPreviewSizeMb: (value) => set({
        maxTextPreviewSizeMb: Math.min(
          MAX_TEXT_PREVIEW_SIZE_MB,
          Math.max(MIN_TEXT_PREVIEW_SIZE_MB, Math.round(value))
        ),
      }),
      setAutoRefreshOnFocus: (autoRefreshOnFocus) => set({ autoRefreshOnFocus }),
      localCacheEnabled: true,
      localCacheMaxMb: 1024,
      setLocalCacheEnabled: (localCacheEnabled) => set({ localCacheEnabled }),
      setLocalCacheMaxMb: (value) => set({
        localCacheMaxMb: Math.min(MAX_LOCAL_CACHE_MB, Math.max(MIN_LOCAL_CACHE_MB, Math.round(value))),
      }),
    }),
    {
      name: 'brows3-settings',
      storage: browserStorage,
    }
  )
);
