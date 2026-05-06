export type RuntimeMode = 'local' | 'hybrid' | 'cloud';
export type TranslationProviderId = 'auto' | 'local-fixture' | 'codex-auth' | 'chatgpt-api' | 'gemini-api' | 'deepl-fallback';
export type WorkerPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'error';
export type TranscriptSource = 'fixture' | 'live-capture';
export type HostPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin';
export type CapturePhase =
  | 'idle'
  | 'probing'
  | 'ready'
  | 'capturing'
  | 'recovering'
  | 'unsupported'
  | 'error';
export type CaptureBackend =
  | 'windows-wasapi-loopback'
  | 'macos-avfoundation-input'
  | 'macos-blackhole'
  | 'macos-coreaudio-tap'
  | 'macos-screencapturekit-native'
  | 'macos-screencapturekit'
  | 'manual-audio-routing'
  | 'unavailable';

export interface CaptureBackendOption {
  key: CaptureBackend;
  label: string;
  availability: 'native-ready' | 'manual-setup' | 'planned' | 'unsupported';
  selectable: boolean;
  recommended: boolean;
  description: string;
  setupHint: string;
}

export interface CaptureSnapshot {
  phase: CapturePhase;
  backend: CaptureBackend;
  target: 'system-audio';
  platform: HostPlatform;
  deviceLabel: string | null;
  supportsSystemAudio: boolean;
  recoveryAttempts: number;
  guidance: string;
  lastError: string | null;
  backendLabel: string;
  backendAvailability: CaptureBackendOption['availability'];
  availableBackends: CaptureBackendOption[];
}

export interface ProviderSummary {
  stt: string;
  translation: string;
}

export interface TranslationProviderStatus {
  id: TranslationProviderId;
  label: string;
  configured: boolean;
  available: boolean;
  state: 'ready' | 'missing-config' | 'manual-auth' | 'unavailable' | 'active' | 'fallback-active';
  detail: string;
}

export interface TranslationRouteStatus {
  selected: TranslationProviderId;
  active: TranslationProviderId;
  fallbackUsed: boolean;
  selectedLabel: string;
  activeLabel: string;
  detail: string;
  providerStatuses: TranslationProviderStatus[];
}

export interface ModeDescriptor {
  label: string;
  description: string;
  localFirst: boolean;
  cloudEnabled: boolean;
  requiresCredentials: boolean;
}

export interface TranscriptLine {
  id: string;
  sourceText: string;
  translatedText: string;
  replySuggestions: ReplySuggestion[];
  sourceFinal: boolean;
  translatedFinal: boolean;
  createdAt: string;
}

export interface ReplySuggestion {
  id: string;
  korean: string;
  japanese: string;
  reading: string;
}

export interface WorkerSnapshot {
  phase: WorkerPhase;
  mode: RuntimeMode;
  sourceLanguage: 'ja';
  targetLanguage: 'ko';
  transcriptSource: TranscriptSource;
  transcriptSourceLabel: string;
  liveCaptureImplemented: boolean;
  providerSummary: ProviderSummary;
  translationRoute: TranslationRouteStatus;
  modeDescriptor: ModeDescriptor;
  capture: CaptureSnapshot;
  startedAt: string | null;
  lastError: string | null;
  retryCount: number;
  healthMessage: string;
  logPath: string | null;
  debugLogPath: string | null;
  logDirectory: string | null;
  logPathDetail: string | null;
  routeLabel: string;
  lines: TranscriptLine[];
}
