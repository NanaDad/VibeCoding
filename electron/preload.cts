import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeMode, TranslationProviderId, WorkerSnapshot } from './shared/runtime-contract.js';
import type { ProviderConfigState } from './main/config-store.js';

function tracePermission(event: string, payload: Record<string, unknown> = {}) {
  const enriched = {
    source: 'preload',
    event,
    timestamp: new Date().toISOString(),
    ...payload
  };
  console.log('[permission-trace]', enriched);
  ipcRenderer.send('debug:permission-trace', enriched);
}

const bridge = {
  getWorkerStatus: (): Promise<WorkerSnapshot> => ipcRenderer.invoke('worker:get-status'),
  startWorker: (mode: RuntimeMode, provider?: TranslationProviderId): Promise<WorkerSnapshot> =>
    ipcRenderer.invoke('worker:start', { mode, provider }),
  stopWorker: (): Promise<WorkerSnapshot> => ipcRenderer.invoke('worker:stop'),
  getProviderConfig: (): Promise<ProviderConfigState> => ipcRenderer.invoke('provider-config:get'),
  saveProviderConfig: (payload: ProviderConfigState): Promise<ProviderConfigState> => ipcRenderer.invoke('provider-config:save', payload),
  launchCodexAuth: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('provider-config:launch-codex-auth'),
  probeTranslation: (provider: TranslationProviderId, text?: string): Promise<{ ok: boolean; detail: string; translatedText?: string | null }> =>
    ipcRenderer.invoke('provider-config:probe-translation', { provider, text }),
  pushRendererAudioChunk: (payload: { data: number[]; mimeType: string }): void => {
    ipcRenderer.send('renderer-audio:chunk', payload);
  },
  requestMicrophonePermission: async (): Promise<{ ok: boolean; detail: string; status: string }> => {
    tracePermission('preload.requestMicrophonePermission.invoke');
    try {
      const result = await ipcRenderer.invoke('permissions:request-microphone');
      tracePermission('preload.requestMicrophonePermission.result', result as Record<string, unknown>);
      return result;
    } catch (error) {
      tracePermission('preload.requestMicrophonePermission.error', {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null } : String(error)
      });
      throw error;
    }
  },
  openMicrophoneSettings: async (): Promise<{ ok: boolean; detail: string }> => {
    tracePermission('preload.openMicrophoneSettings.invoke');
    try {
      const result = await ipcRenderer.invoke('permissions:open-microphone-settings');
      tracePermission('preload.openMicrophoneSettings.result', result as Record<string, unknown>);
      return result;
    } catch (error) {
      tracePermission('preload.openMicrophoneSettings.error', {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null } : String(error)
      });
      throw error;
    }
  },
  openScreenCaptureSettings: async (): Promise<{ ok: boolean; detail: string }> => {
    tracePermission('preload.openScreenCaptureSettings.invoke');
    try {
      const result = await ipcRenderer.invoke('permissions:open-screen-capture-settings');
      tracePermission('preload.openScreenCaptureSettings.result', result as Record<string, unknown>);
      return result;
    } catch (error) {
      tracePermission('preload.openScreenCaptureSettings.error', {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? null } : String(error)
      });
      throw error;
    }
  },
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
  onWorkerStatus: (listener: (snapshot: WorkerSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: WorkerSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on('worker:status', wrapped);
    return () => ipcRenderer.removeListener('worker:status', wrapped);
  }
};

contextBridge.exposeInMainWorld('translatorRuntime', bridge);

declare global {
  interface Window {
    translatorRuntime: typeof bridge;
  }
}

export type { ProviderConfigState } from './main/config-store.js';
export type {
  CaptureBackendOption,
  CaptureSnapshot,
  RuntimeMode,
  TranslationProviderId,
  TranslationProviderStatus,
  TranslationRouteStatus,
  WorkerSnapshot
} from './shared/runtime-contract.js';
