import { useEffect, useMemo, useState } from 'react';
import type {
  CaptureSnapshot,
  ProviderConfigState,
  RuntimeMode,
  TranslationProviderId,
  TranslationProviderStatus,
  WorkerSnapshot
} from '../electron/preload';

type ViewId = 'translate' | 'settings';

const providerOrder: TranslationProviderId[] = ['codex-auth', 'auto', 'chatgpt-api', 'gemini-api', 'deepl-fallback', 'local-fixture'];

const providerLabels: Record<TranslationProviderId, string> = {
  auto: '자동 선택',
  'codex-auth': 'Codex auth',
  'chatgpt-api': 'GPT API',
  'gemini-api': 'Gemini',
  'deepl-fallback': 'DeepL',
  'local-fixture': '로컬 테스트'
};

const modeLabels: Record<RuntimeMode, string> = {
  hybrid: '권장',
  cloud: '클라우드 번역',
  local: '로컬 확인'
};

const defaultProviderStatuses: TranslationProviderStatus[] = providerOrder.map((id) => ({
  id,
  label: providerLabels[id],
  configured: id === 'local-fixture',
  available: id === 'local-fixture',
  state: id === 'local-fixture' ? 'ready' : id === 'codex-auth' ? 'manual-auth' : 'missing-config',
  detail: id === 'codex-auth' ? 'Codex CLI 로그인 세션을 사용합니다.' : '설정이 필요합니다.'
}));

const emptyConfig: ProviderConfigState = {
  codexAuthPath: '',
  values: {
    chatgptApiKey: '',
    openaiBaseUrl: '',
    chatgptModel: '',
    geminiApiKey: '',
    geminiBaseUrl: '',
    geminiModel: '',
    deeplApiKey: '',
    deeplBaseUrl: '',
    codexModel: '',
    macosCaptureDevice: '',
    windowsCaptureDevice: '',
    ffmpegPath: '',
    whisperPath: '',
    whisperModelPath: '',
    userContext: '',
    glossary: ''
  }
};

const idleCapture: CaptureSnapshot = {
  phase: 'ready',
  backend: 'windows-wasapi-loopback',
  target: 'system-audio',
  platform: 'win32',
  deviceLabel: 'Default Windows Output',
  supportsSystemAudio: true,
  recoveryAttempts: 0,
  guidance: 'Windows 시스템 소리를 Electron loopback으로 받아옵니다.',
  lastError: null,
  backendLabel: 'Electron Desktop Audio Bridge',
  backendAvailability: 'native-ready',
  availableBackends: []
};

const idleSnapshot: WorkerSnapshot = {
  phase: 'idle',
  mode: 'hybrid',
  sourceLanguage: 'ja',
  targetLanguage: 'ko',
  transcriptSource: 'live-capture',
  transcriptSourceLabel: '실시간 오디오 입력',
  liveCaptureImplemented: true,
  providerSummary: { stt: 'live-capture.ffmpeg+whisper', translation: 'codex-auth' },
  translationRoute: {
    selected: 'codex-auth',
    active: 'codex-auth',
    fallbackUsed: false,
    selectedLabel: 'Codex auth',
    activeLabel: 'Codex auth',
    detail: '번역 경로를 준비 중입니다.',
    providerStatuses: defaultProviderStatuses
  },
  modeDescriptor: {
    label: '권장',
    description: '로컬 STT와 Codex auth 번역을 함께 사용합니다.',
    localFirst: true,
    cloudEnabled: true,
    requiresCredentials: true
  },
  capture: idleCapture,
  startedAt: null,
  lastError: null,
  retryCount: 0,
  healthMessage: '대기 중입니다.',
  logPath: null,
  debugLogPath: null,
  logDirectory: null,
  logPathDetail: null,
  routeLabel: '오디오 입력 + Codex auth',
  lines: []
};

function phaseText(phase: WorkerSnapshot['phase']) {
  switch (phase) {
    case 'starting': return '시작 중';
    case 'running': return '번역 중';
    case 'stopping': return '정지 중';
    case 'error': return '오류';
    default: return '대기';
  }
}

function getFallbackSuggestions() {
  return [
    {
      id: 'fallback-1',
      korean: '확인했습니다. 로그를 먼저 열어볼게요.',
      japanese: '確認しました。まずログを開いて確認します。',
      reading: 'kakunin shimashita. mazu rogu o hiraite kakunin shimasu.'
    },
    {
      id: 'fallback-2',
      korean: '기동 전류 파형도 같이 비교해 보겠습니다.',
      japanese: '起動電流の波形もあわせて比較します。',
      reading: 'kido denryu no hakei mo awasete hikaku shimasu.'
    },
    {
      id: 'fallback-3',
      korean: '보호 회로 조건을 용어집 기준으로 정리하겠습니다.',
      japanese: '保護回路の条件を用語集に沿って整理します。',
      reading: 'hogo kairo no joken o yogoshu ni sotte seiri shimasu.'
    }
  ];
}

function providerStateText(status: TranslationProviderStatus) {
  if (status.state === 'active') return '사용 중';
  if (status.state === 'fallback-active') return '대체 사용';
  if (status.available) return '준비됨';
  if (status.state === 'manual-auth') return '로그인 필요';
  return '설정 필요';
}

type AudioCaptureSession = {
  stop: () => void;
};

const audioHopMs = 1_000;
const rollingWindowMs = 6_000;
const minRollingWindowMs = 2_000;
const wavSampleRate = 16_000;
const useRendererAudioBridge = false;

function mergeFloat32Buffers(buffers: Float32Array[]) {
  const length = buffers.reduce((total, buffer) => total + buffer.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(buffer, offset);
    offset += buffer.length;
  }
  return merged;
}

function downsampleBuffer(input: Float32Array, inputSampleRate: number, outputSampleRate: number) {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j];
      count += 1;
    }
    output[i] = count > 0 ? sum / count : 0;
  }
  return output;
}

function encodeMonoWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}

export function App() {
  const runtime = window.translatorRuntime;
  const [view, setView] = useState<ViewId>('translate');
  const [snapshot, setSnapshot] = useState<WorkerSnapshot>(idleSnapshot);
  const [mode, setMode] = useState<RuntimeMode>('hybrid');
  const [selectedProvider, setSelectedProvider] = useState<TranslationProviderId>('codex-auth');
  const [providerConfig, setProviderConfig] = useState<ProviderConfigState>(emptyConfig);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [audioCapture, setAudioCapture] = useState<AudioCaptureSession | null>(null);
  const [audioBridge, setAudioBridge] = useState({
    state: 'idle' as 'idle' | 'starting' | 'recording' | 'error',
    detail: '시작을 누르면 whisper.cpp stream.exe가 오디오 장치를 직접 열어 받아쓰기합니다.',
    chunks: 0,
    bytes: 0
  });

  useEffect(() => {
    if (!runtime) {
      setBridgeError('Electron preload bridge를 찾지 못했습니다.');
      return undefined;
    }

    Promise.all([runtime.getWorkerStatus(), runtime.getProviderConfig()])
      .then(([status, config]) => {
        setSnapshot(status);
        setMode(status.mode);
        setSelectedProvider(status.translationRoute.selected === 'local-fixture' ? 'codex-auth' : status.translationRoute.selected);
        setProviderConfig(config);
        setBridgeError(null);
      })
      .catch((error: Error) => setBridgeError(error.message));

    const cleanup = runtime.onWorkerStatus((status) => {
      setSnapshot(status);
      setMode(status.mode);
      setBridgeError(null);
    });
    return () => {
      cleanup();
    };
  }, [runtime]);

  const providerStatuses = snapshot.translationRoute.providerStatuses.length > 0
    ? snapshot.translationRoute.providerStatuses
    : defaultProviderStatuses;
  const selectedStatus = providerStatuses.find((status) => status.id === selectedProvider) ?? defaultProviderStatuses[0];
  const latestLine = [...snapshot.lines].reverse().find((line) => line.translatedText.trim()) ?? snapshot.lines[snapshot.lines.length - 1] ?? null;
  const suggestions = latestLine?.replySuggestions?.length ? latestLine.replySuggestions : getFallbackSuggestions();
  const isBusy = snapshot.phase === 'starting' || snapshot.phase === 'stopping';
  const selectedUnavailable =
    selectedProvider !== 'local-fixture'
    && selectedProvider !== 'auto'
    && !selectedStatus.available
    && selectedStatus.state !== 'manual-auth';
  const canStart = Boolean(runtime) && !bridgeError && !isBusy && snapshot.phase !== 'running' && !selectedUnavailable;
  const canStop = Boolean(runtime) && !bridgeError && !isBusy && snapshot.phase !== 'idle';

  const statusMessage = useMemo(() => {
    if (bridgeError) return bridgeError;
    if (snapshot.lastError) return snapshot.lastError;
    if (notice) return notice;
    return snapshot.healthMessage;
  }, [bridgeError, notice, snapshot.healthMessage, snapshot.lastError]);

  const updateConfig = (updater: (prev: ProviderConfigState) => ProviderConfigState) => {
    setProviderConfig(updater);
    setNotice(null);
  };

  const saveConfig = async () => {
    if (!runtime) return;
    setBusyAction('save');
    try {
      const saved = await runtime.saveProviderConfig(providerConfig);
      setProviderConfig(saved);
      setNotice('설정을 저장했습니다.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const launchCodexAuth = async () => {
    if (!runtime) return;
    setBusyAction('codex-login');
    try {
      const result = await runtime.launchCodexAuth();
      setNotice(result.detail);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const probeProvider = async (provider: TranslationProviderId = selectedProvider) => {
    if (!runtime) return;
    setBusyAction(`probe-${provider}`);
    try {
      const result = await runtime.probeTranslation(provider);
      setNotice(result.ok
        ? `${providerLabels[provider]} 연결 확인 완료${result.translatedText ? `: ${result.translatedText}` : ''}`
        : result.detail);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const stopRendererAudioCapture = () => {
    if (audioCapture) {
      audioCapture.stop();
    }
    setAudioCapture(null);
    setAudioBridge((prev) => ({
      ...prev,
      state: 'idle',
      detail: '오디오 캡처를 정지했습니다.'
    }));
  };

  const startRendererAudioCapture = async () => {
    if (!runtime || snapshot.capture.platform !== 'win32') {
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('현재 Electron 환경에서 시스템 오디오 캡처 API를 사용할 수 없습니다.');
    }

    setAudioBridge({ state: 'starting', detail: 'Windows loopback 오디오 스트림을 여는 중입니다.', chunks: 0, bytes: 0 });
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Electron이 시스템 오디오 트랙을 받지 못했습니다. 앱을 재시작한 뒤 다시 시도하세요.');
    }

    videoTracks.forEach((track) => {
      track.enabled = false;
    });
    const audioStream = new MediaStream(audioTracks);
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('이 Electron 환경에서 Web Audio API를 사용할 수 없습니다.');
    }

    const context = new AudioContextCtor();
    await context.resume();
    const source = context.createMediaStreamSource(audioStream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    let stopped = false;
    let buffers: Float32Array[] = [];
    let bufferedSamples = 0;

    const flush = () => {
      if (stopped || !runtime || buffers.length === 0) {
        return;
      }
      const merged = mergeFloat32Buffers(buffers);
      if (merged.length < context.sampleRate * (minRollingWindowMs / 1000)) {
        return;
      }

      const wav = encodeMonoWav(downsampleBuffer(merged, context.sampleRate, wavSampleRate), wavSampleRate);
      runtime.pushRendererAudioChunk({
        data: Array.from(wav),
        mimeType: 'audio/wav'
      });
      setAudioBridge((prev) => ({
        state: 'recording',
        detail: `PCM WAV 오디오를 worker로 전달 중입니다. 마지막 청크 ${Math.round(wav.byteLength / 1024)} KB`,
        chunks: prev.chunks + 1,
        bytes: prev.bytes + wav.byteLength
      }));
    };

    processor.onaudioprocess = (event) => {
      if (stopped) {
        return;
      }
      const next = new Float32Array(event.inputBuffer.getChannelData(0));
      buffers.push(next);
      bufferedSamples += next.length;

      const maxSamples = Math.ceil(context.sampleRate * (rollingWindowMs / 1000));
      while (bufferedSamples > maxSamples && buffers.length > 1) {
        const removed = buffers.shift();
        bufferedSamples -= removed?.length ?? 0;
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);

    const timer = window.setInterval(flush, audioHopMs);
    const stopSession = () => {
      if (stopped) {
        return;
      }
      flush();
      stopped = true;
      window.clearInterval(timer);
      processor.disconnect();
      source.disconnect();
      silentGain.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    };

    audioTracks.forEach((track) => {
      track.addEventListener('ended', () => {
        setAudioBridge((prev) => ({
          ...prev,
          state: 'idle',
          detail: '시스템 오디오 스트림이 종료되었습니다.'
        }));
      }, { once: true });
    });

    setAudioCapture({ stop: stopSession });
    setAudioBridge({ state: 'recording', detail: '최근 6초 오디오를 1초마다 겹쳐서 Whisper에 전달합니다.', chunks: 0, bytes: 0 });
  };

  const start = async () => {
    if (!runtime) return;
    setNotice(null);
    try {
      await runtime.startWorker(mode, selectedProvider);
      if (useRendererAudioBridge) {
        await startRendererAudioCapture();
      } else {
        setAudioBridge({
          state: 'recording',
          detail: 'whisper.cpp stream.exe가 상시 실행 중입니다. 텍스트 stdout을 받아 번역합니다.',
          chunks: 0,
          bytes: 0
        });
      }
    } catch (error) {
      await runtime.stopWorker().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      setAudioBridge((prev) => ({ ...prev, state: 'error', detail: message }));
    }
  };

  const stop = async () => {
    stopRendererAudioCapture();
    await runtime?.stopWorker();
  };

  const copySuggestion = async (text: string) => {
    await navigator.clipboard?.writeText(text);
    setNotice('답변 후보를 복사했습니다.');
  };

  return (
    <div className="workspace">
      <nav className="rail" aria-label="Primary">
        <div className="rail-mark">JP<br />KO</div>
        <button type="button" className={view === 'translate' ? 'rail-item active' : 'rail-item'} onClick={() => setView('translate')}>번역</button>
        <button type="button" className={view === 'settings' ? 'rail-item active' : 'rail-item'} onClick={() => setView('settings')}>설정</button>
      </nav>

      <main className="app">
        <header className="topbar">
          <div>
            <h1>{view === 'translate' ? 'Realtime JP-KO Translator' : 'Settings'}</h1>
            <p>{view === 'translate' ? '일본어 시스템 음성을 한국어로 받아쓰고 번역합니다.' : 'Codex auth, 오디오, 내 환경, 용어집을 관리합니다.'}</p>
          </div>
          <div className="topbar-actions">
            <span className={`status-chip phase-${snapshot.phase}`}>{phaseText(snapshot.phase)}</span>
            {view === 'translate' ? (
              <>
                <button type="button" className="primary" disabled={!canStart} onClick={() => void start()}>시작</button>
                <button type="button" className="danger" disabled={!canStop} onClick={() => void stop()}>정지</button>
              </>
            ) : (
              <button type="button" className="primary" disabled={busyAction === 'save'} onClick={() => void saveConfig()}>저장</button>
            )}
          </div>
        </header>

        {statusMessage ? <div className="notice-banner" role="status">{statusMessage}</div> : null}

        {view === 'translate' ? (
          <section className="translate-view">
            <section className="stage-main">
              <div className="stage-head">
                <span>Japanese source</span>
                <strong>{snapshot.capture.backendLabel}</strong>
              </div>
              <p className="source-text">{latestLine?.sourceText || '시작을 누르면 Windows 시스템 소리를 받아쓰기합니다.'}</p>
              <div className="divider" />
              <span className="block-label">Korean translation</span>
              <p className="translation-text">{latestLine?.translatedText || '번역 결과가 여기에 크게 표시됩니다.'}</p>
              <div className={`audio-status audio-${audioBridge.state}`}>
                <strong>{audioBridge.state === 'recording' ? '오디오 입력 중' : audioBridge.state === 'error' ? '오디오 오류' : '오디오 대기'}</strong>
                <span>{audioBridge.detail}</span>
                <small>chunks {audioBridge.chunks} · {Math.round(audioBridge.bytes / 1024)} KB</small>
              </div>
            </section>

            <aside className="reply-panel">
              <div>
                <h2>답변 후보</h2>
                <p>한국어 답변, 일본어 문장, 음독을 함께 보여줍니다.</p>
              </div>
              <div className="reply-list">
                {suggestions.slice(0, 3).map((item) => (
                  <article className="reply-option" key={item.id}>
                    <strong>{item.korean}</strong>
                    <p>{item.japanese}</p>
                    <small>{item.reading}</small>
                    <button type="button" className="secondary" onClick={() => void copySuggestion(`${item.korean}\n${item.japanese}\n${item.reading}`)}>복사</button>
                  </article>
                ))}
              </div>
            </aside>
          </section>
        ) : (
          <section className="settings-view">
            <section className="settings-panel">
              <h2>번역 경로</h2>
              <div className="form-grid">
                <label>
                  <span>실행 모드</span>
                  <select value={mode} disabled={snapshot.phase === 'running'} onChange={(event) => setMode(event.target.value as RuntimeMode)}>
                    {Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label>
                  <span>번역 provider</span>
                  <select value={selectedProvider} disabled={snapshot.phase === 'running'} onChange={(event) => setSelectedProvider(event.target.value as TranslationProviderId)}>
                    {providerOrder.map((id) => <option key={id} value={id}>{providerLabels[id]}</option>)}
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="secondary" disabled={busyAction?.startsWith('probe')} onClick={() => void probeProvider()}>연결 테스트</button>
                <button type="button" className="secondary" disabled={busyAction === 'codex-login'} onClick={() => void launchCodexAuth()}>Codex 로그인</button>
              </div>
              <div className="provider-strip">
                {providerStatuses.map((status) => (
                  <span key={status.id}>{status.label}: {providerStateText(status)}</span>
                ))}
              </div>
            </section>

            <section className="settings-panel">
              <h2>내 환경과 용어집</h2>
              <div className="form-grid two">
                <label>
                  <span>내 환경</span>
                  <textarea value={providerConfig.values.userContext} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, userContext: event.target.value } }))} placeholder="예: Windows/Electron 개발자, 장비 펌웨어와 보호 회로 로그를 자주 다룸" />
                </label>
                <label>
                  <span>용어집</span>
                  <textarea value={providerConfig.values.glossary} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, glossary: event.target.value } }))} placeholder="예: 保護回路=보호 회로, 起動電流=기동 전류, 波形=파형" />
                </label>
              </div>
            </section>

            <section className="settings-panel">
              <h2>고급 설정</h2>
              <div className="form-grid">
                <label>
                  <span>Codex auth.json 경로</span>
                  <input value={providerConfig.codexAuthPath} onChange={(event) => updateConfig((prev) => ({ ...prev, codexAuthPath: event.target.value }))} placeholder="비워두면 기본 .codex/auth.json 사용" />
                </label>
                <label>
                  <span>Codex 모델</span>
                  <input value={providerConfig.values.codexModel} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, codexModel: event.target.value } }))} placeholder="비워두면 Codex 기본값" />
                </label>
                <label>
                  <span>Windows 캡처 장치</span>
                  <input value={providerConfig.values.windowsCaptureDevice} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, windowsCaptureDevice: event.target.value } }))} placeholder="비워두면 Electron loopback 사용" />
                </label>
              </div>
              <button type="button" className="secondary wide" onClick={() => setShowApiKeys((value) => !value)}>{showApiKeys ? 'API 키 숨기기' : 'API 키 대체 경로 보기'}</button>
              {showApiKeys ? (
                <div className="api-fields">
                  <label><span>OpenAI API key</span><input type="password" value={providerConfig.values.chatgptApiKey} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, chatgptApiKey: event.target.value } }))} /></label>
                  <label><span>Gemini API key</span><input type="password" value={providerConfig.values.geminiApiKey} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, geminiApiKey: event.target.value } }))} /></label>
                  <label><span>DeepL API key</span><input type="password" value={providerConfig.values.deeplApiKey} onChange={(event) => updateConfig((prev) => ({ ...prev, values: { ...prev.values, deeplApiKey: event.target.value } }))} /></label>
                </div>
              ) : null}
            </section>
          </section>
        )}

        <footer className="statusbar">
          <span>Provider: {snapshot.translationRoute.activeLabel}</span>
          <span>STT: {snapshot.providerSummary.stt}</span>
          <span>{snapshot.logPathDetail || snapshot.logPath || '로그 경로 준비 중'}</span>
        </footer>
      </main>
    </div>
  );
}
