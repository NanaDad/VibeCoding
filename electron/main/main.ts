import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCaptureSnapshot } from '../shared/capture-backends.js';
import { createDebugLogger, type DebugLogger } from '../shared/debug-log.js';
import type { RuntimeMode, TranslationProviderId, WorkerSnapshot } from '../shared/runtime-contract.js';
import { runTranslationProbe } from '../worker/runtime-core.js';
import {
  buildWorkerEnv,
  createDefaultProviderConfigState,
  loadProviderConfigState,
  saveProviderConfigState,
  type ProviderConfigState
} from './config-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rendererIndex = path.join(__dirname, '../../dist/index.html');
const workerEntry = path.join(__dirname, '../worker/runtime-worker.js');

let mainWindow: BrowserWindow | null = null;
let runtimeWorker: ChildProcess | null = null;
let debugLogger: DebugLogger | null = null;
let providerConfigState: ProviderConfigState = createDefaultProviderConfigState();
let lastRequestedMode: RuntimeMode = 'local';
let lastRequestedProvider: TranslationProviderId = 'auto';
let expectedWorkerExit = false;

type MicrophoneAccessStatus = ReturnType<typeof systemPreferences.getMediaAccessStatus>;

function getMicrophonePermissionContext() {
  const appPath = app.getAppPath();
  const execPath = process.execPath;
  const resourcesPath = process.resourcesPath;
  const looksLikePackagedApp = execPath.endsWith('.app/Contents/MacOS/Electron') || execPath.includes('.app/Contents/MacOS/');

  return {
    isPackaged: app.isPackaged,
    defaultApp: (app as typeof app & { defaultApp?: boolean }).defaultApp ?? false,
    appName: app.getName(),
    appPath,
    execPath,
    resourcesPath,
    looksLikePackagedApp,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    argv: process.argv,
    pid: process.pid
  };
}

async function readMacInfoPlistUsageDescription() {
  if (process.platform !== 'darwin') {
    return null;
  }

  const candidates = [
    path.join(process.execPath, '..', '../Info.plist'),
    path.join(process.resourcesPath, '../Info.plist')
  ];

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, 'utf8');
      const match = content.match(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>([\s\S]*?)<\/string>/);
      return {
        path: candidate,
        found: Boolean(match),
        value: match?.[1] ?? null
      };
    } catch {
      continue;
    }
  }

  return {
    path: null,
    found: false,
    value: null
  };
}

async function debug(event: string, payload: Record<string, unknown> = {}) {
  if (!debugLogger) {
    return;
  }
  await debugLogger.log(event, payload);
}

async function openMacMicrophonePrivacySettings() {
  if (process.platform !== 'darwin') {
    return false;
  }

  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    return true;
  } catch {
    const child = spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }
}

async function openMacScreenCapturePrivacySettings() {
  if (process.platform !== 'darwin') {
    return false;
  }

  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  } catch {
    const child = spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }
}

async function resolveCodexCliForLogin() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(app.getPath('home'), '.codex', 'bin', 'codex.exe'),
        path.join(app.getPath('home'), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe')
      ]
    : [];

  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const lookup = await new Promise<string[]>((resolve) => {
    execFile(lookupCommand, ['codex'], { windowsHide: true }, (_error, stdout) => {
      resolve(stdout.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean));
    });
  }).catch(() => []);

  candidates.push(...lookup);

  const normalizedCandidates = [...new Set(candidates)]
    .filter((candidate) => process.platform !== 'win32' || path.extname(candidate).toLowerCase() === '.exe')
    .sort((left, right) => {
      const leftWindowsApps = process.platform === 'win32' && left.includes(`${path.sep}WindowsApps${path.sep}`);
      const rightWindowsApps = process.platform === 'win32' && right.includes(`${path.sep}WindowsApps${path.sep}`);
      return Number(leftWindowsApps) - Number(rightWindowsApps);
    });

  for (const candidate of normalizedCandidates) {
    if (process.platform === 'win32' && candidate.includes(`${path.sep}WindowsApps${path.sep}`)) {
      const copiedPath = path.join(app.getPath('home'), '.codex', 'bin', 'codex.exe');
      try {
        await fs.mkdir(path.dirname(copiedPath), { recursive: true });
        await fs.copyFile(candidate, copiedPath);
        await new Promise<void>((resolve, reject) => {
          execFile(copiedPath, ['--version'], { windowsHide: true }, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        return copiedPath;
      } catch {
        continue;
      }
    }

    try {
      await fs.access(candidate);
      await new Promise<void>((resolve, reject) => {
        execFile(candidate, ['--version'], { windowsHide: true }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function launchCodexLoginTerminal(codexCliPath: string) {
  const codexHome = path.join(app.getPath('home'), '.codex');
  const command = [
    `$env:CODEX_HOME = ${JSON.stringify(codexHome)}`,
    'Write-Host "Codex ChatGPT device login"',
    'Write-Host "1. A browser page will open at https://auth.openai.com/codex/device"',
    'Write-Host "2. Enter the one-time code shown below"',
    'Write-Host ""',
    `& ${JSON.stringify(codexCliPath)} login --device-auth`,
    'Write-Host ""',
    'Write-Host "Codex login command finished. You can close this window after the browser login is complete."'
  ].join('; ');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoExit', '-EncodedCommand', encodedCommand], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
}

async function getCodexLoginStatus(codexCliPath: string) {
  const codexHome = path.join(app.getPath('home'), '.codex');
  return new Promise<{ loggedIn: boolean; detail: string }>((resolve) => {
    execFile(codexCliPath, ['login', 'status'], {
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: codexHome
      }
    }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (!error && /logged in/i.test(output)) {
        resolve({ loggedIn: true, detail: output });
        return;
      }
      resolve({ loggedIn: false, detail: output || (error ? error.message : 'Codex login status is unknown.') });
    });
  });
}

function buildMicrophonePermissionDetail(status: MicrophoneAccessStatus, promptAttempted: boolean) {
  switch (status) {
    case 'granted':
      return '마이크 권한이 허용되었습니다. 앱을 다시 시작하면 장치 확인이 바로 이어집니다.';
    case 'denied':
      return '마이크 권한이 거부되어 있습니다. 시스템 설정의 개인정보 보호 > 마이크에서 이 앱을 직접 허용해야 합니다.';
    case 'restricted':
      return '이 Mac 정책 때문에 마이크 권한을 바꿀 수 없습니다. 시스템 설정 또는 관리자 정책을 확인해야 합니다.';
    case 'not-determined':
      return promptAttempted
        ? '마이크 권한 요청을 보냈지만 macOS 승인 창이 나타나지 않았습니다. 개발 실행 상태이거나 앱 번들의 권한 설명이 없으면 이런 현상이 날 수 있습니다.'
        : '마이크 권한을 아직 요청하지 않았습니다.';
    default:
      return `마이크 권한 상태: ${status}`;
  }
}

let workerSnapshot: WorkerSnapshot = {
  phase: 'idle',
  mode: 'local',
  sourceLanguage: 'ja',
  targetLanguage: 'ko',
  transcriptSource: process.platform === 'win32' || process.platform === 'darwin' ? 'live-capture' : 'fixture',
  transcriptSourceLabel: process.platform === 'win32' || process.platform === 'darwin' ? '실시간 오디오 입력' : '샘플 입력',
  liveCaptureImplemented: process.platform === 'win32' || process.platform === 'darwin',
  providerSummary: {
    stt: process.platform === 'win32' || process.platform === 'darwin' ? 'live-capture.ffmpeg+whisper' : 'fixture.transcript-feed',
    translation: 'local.fixture-check-only'
  },
  translationRoute: {
    selected: 'auto',
    active: 'local-fixture',
    fallbackUsed: false,
    selectedLabel: '자동 선택',
    activeLabel: '기본 확인',
    detail: '설정된 번역 provider가 있으면 자동 선택하고, 없으면 기본 확인으로 대기합니다.',
    providerStatuses: []
  },
  modeDescriptor: {
    label: '기본 확인',
    description: '실오디오 입력을 로컬 캡처와 로컬 전사로 받아 빠르게 확인하는 모드입니다.',
    localFirst: true,
    cloudEnabled: false,
    requiresCredentials: false
  },
  capture: createCaptureSnapshot(process.platform),
  startedAt: null,
  lastError: null,
  retryCount: 0,
  healthMessage: '실행 대기 중입니다.',
  logPath: null,
  debugLogPath: null,
  logDirectory: null,
  logPathDetail: null,
  routeLabel: '실오디오 입력 + 기본 확인',
  lines: []
};

function broadcastSnapshot() {
  if (mainWindow) {
    mainWindow.webContents.send('worker:status', workerSnapshot);
  }
  void debug('main.snapshot.broadcast', {
    phase: workerSnapshot.phase,
    mode: workerSnapshot.mode,
    retryCount: workerSnapshot.retryCount,
    capturePhase: workerSnapshot.capture.phase,
    lineCount: workerSnapshot.lines.length,
    lastError: workerSnapshot.lastError
  });
}

function attachWorkerListeners(worker: ChildProcess) {
  worker.on('message', (message: { type?: string; payload?: WorkerSnapshot }) => {
    void debug('main.worker.message', {
      messageType: message.type ?? 'unknown',
      hasPayload: Boolean(message.payload)
    });
    if (message.type === 'status' && message.payload) {
      workerSnapshot = message.payload;
      broadcastSnapshot();
    }
  });

  worker.on('disconnect', () => {
    void debug('main.worker.disconnect', {
      pid: worker.pid ?? null,
      expectedWorkerExit
    });
  });

  worker.on('spawn', () => {
    void debug('main.worker.spawn', {
      pid: worker.pid ?? null
    });
  });

  worker.on('exit', (code, signal) => {
    const shouldRespawn =
      !expectedWorkerExit && Boolean(mainWindow) && (workerSnapshot.phase === 'starting' || workerSnapshot.phase === 'running');

    void debug('main.worker.exit', {
      code,
      signal,
      expectedWorkerExit,
      shouldRespawn,
      phase: workerSnapshot.phase,
      mode: workerSnapshot.mode,
      provider: lastRequestedProvider
    });

    runtimeWorker = null;

    if (shouldRespawn) {
      workerSnapshot = {
        ...workerSnapshot,
        phase: 'starting',
        lastError: signal
          ? `Worker exited unexpectedly via ${signal}; restarting runtime.`
          : `Worker exited unexpectedly with code ${code}; restarting runtime.`
      };
      broadcastSnapshot();
      void ensureWorker(lastRequestedMode, lastRequestedProvider);
      return;
    }

    workerSnapshot = {
      ...workerSnapshot,
      phase: code === 0 || expectedWorkerExit ? 'idle' : 'error',
      lastError:
        code === 0 || expectedWorkerExit
          ? null
          : signal
            ? `Worker exited via ${signal}`
            : `Worker exited with code ${code}`
    };
    expectedWorkerExit = false;
    broadcastSnapshot();
  });

  worker.on('error', (error) => {
    void debug('main.worker.error', { error });
    workerSnapshot = {
      ...workerSnapshot,
      phase: 'error',
      lastError: error.message
    };
    broadcastSnapshot();
  });
}

function spawnRuntimeWorker() {
  expectedWorkerExit = false;
  const worker = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      ...buildWorkerEnv(providerConfigState),
      ...(process.platform === 'win32' ? { TRANSLATOR_STT_BACKEND: 'whisper-stream' } : {}),
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });

  worker.stdout?.on('data', (chunk) => {
    void debug('main.worker.stdout', { chunk: String(chunk).trim() });
  });
  worker.stderr?.on('data', (chunk) => {
    void debug('main.worker.stderr', { chunk: String(chunk).trim() });
  });

  attachWorkerListeners(worker);
  void debug('main.worker.spawned', {
    pid: worker.pid ?? null,
    workerEntry,
    execPath: process.execPath,
    electronRunAsNode: '1'
  });

  return worker;
}

async function ensureWorker(mode: RuntimeMode, provider: TranslationProviderId) {
  lastRequestedMode = mode;
  lastRequestedProvider = provider;

  if (!runtimeWorker || runtimeWorker.killed) {
    runtimeWorker = spawnRuntimeWorker();
  }

  workerSnapshot = {
    ...workerSnapshot,
    phase: 'starting',
    mode,
    translationRoute: {
      ...workerSnapshot.translationRoute,
      selected: provider,
      active: provider
    },
    lastError: null
  };
  broadcastSnapshot();

  const { path: logDirectory, reason: logReason } = await resolveLogDirectory();
  runtimeWorker.send({
    type: 'start',
    mode,
    provider,
    logDirectory,
    debugLogDirectory: logDirectory
  });

  await debug('main.worker.start.sent', {
    mode,
    provider,
    logDirectory,
    logReason
  });

  return workerSnapshot;
}

async function stopWorker() {
  expectedWorkerExit = true;

  if (!runtimeWorker || runtimeWorker.killed) {
    workerSnapshot = {
      ...workerSnapshot,
      phase: 'idle',
      startedAt: null
    };
    broadcastSnapshot();
    await debug('main.worker.stop.skip', {
      hasWorker: false
    });
    return workerSnapshot;
  }

  await debug('main.worker.stop.request', {
    phase: workerSnapshot.phase,
    mode: workerSnapshot.mode
  });

  runtimeWorker.send({ type: 'stop' });
  return workerSnapshot;
}

async function resolveLogDirectory() {
  const portableCandidates = [
    path.dirname(process.execPath),
    process.cwd()
  ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);

  for (const candidate of portableCandidates) {
    try {
      const target = path.join(candidate, 'logs');
      await fs.mkdir(target, { recursive: true });
      await fs.access(target);
      return { path: target, reason: 'executable-near' as const };
    } catch {
      continue;
    }
  }

  const fallback = path.join(app.getPath('userData'), 'logs');
  await fs.mkdir(fallback, { recursive: true });
  return { path: fallback, reason: 'userData-fallback' as const };
}

function configureWindowsLoopbackCapture() {
  if (process.platform !== 'win32') {
    return;
  }

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    }).then((sources) => {
      const source = sources[0];
      if (!source) {
        void debug('main.display-media.no-source', {});
        callback({});
        return;
      }

      void debug('main.display-media.grant-loopback', {
        sourceId: source.id,
        sourceName: source.name
      });
      callback({
        video: {
          id: source.id,
          name: source.name
        },
        audio: 'loopback'
      });
    }).catch((error: Error) => {
      void debug('main.display-media.error', { error: error.message });
      callback({});
    });
  }, { useSystemPicker: false });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#f4f1e8',
    title: 'JP -> KO Realtime Translator',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 20 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload.cjs')
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    void debug('main.window.did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL
    });
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    void debug('main.window.console', {
      level,
      message,
      line,
      sourceId
    });
  });

  await mainWindow.loadFile(rendererIndex);

  await debug('main.window.did-load-file', {
    rendererIndex
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  const { path: logDirectory, reason: logReason } = await resolveLogDirectory();
  providerConfigState = await loadProviderConfigState(userDataPath);
  debugLogger = createDebugLogger({
    logDirectory,
    scope: 'main'
  });
  await debug('main.app.ready', {
    platform: process.platform,
    logDirectory,
    logReason,
    rendererIndex,
    workerEntry
  });
  configureWindowsLoopbackCapture();

  ipcMain.handle('worker:get-status', async () => {
    await debug('main.ipc.get-status', {
      phase: workerSnapshot.phase,
      mode: workerSnapshot.mode
    });
    return workerSnapshot;
  });
  ipcMain.handle(
    'worker:start',
    async (_event, args: { mode?: RuntimeMode; provider?: TranslationProviderId } | RuntimeMode) => {
      const mode = typeof args === 'string' ? args : args.mode ?? 'local';
      const provider =
        typeof args === 'string' ? 'auto' : args.provider ?? (mode === 'local' ? 'local-fixture' : 'auto');
      await debug('main.ipc.start', { mode, provider });
      return ensureWorker(mode, provider);
    }
  );
  ipcMain.handle('worker:stop', async () => {
    await debug('main.ipc.stop');
    return stopWorker();
  });
  ipcMain.on('renderer-audio:chunk', (_event, payload: { data?: number[]; mimeType?: string }) => {
    if (!runtimeWorker || runtimeWorker.killed || workerSnapshot.phase !== 'running') {
      return;
    }
    runtimeWorker.send({
      type: 'renderer-audio-chunk',
      data: payload.data ?? [],
      mimeType: payload.mimeType ?? 'audio/webm'
    });
  });
  ipcMain.handle('provider-config:get', async () => providerConfigState);
  ipcMain.handle('provider-config:save', async (_event, payload: ProviderConfigState) => {
    providerConfigState = await saveProviderConfigState(userDataPath, payload);
    if (runtimeWorker && !runtimeWorker.killed) {
      expectedWorkerExit = true;
      runtimeWorker.kill();
      runtimeWorker = null;
      expectedWorkerExit = false;
    }
    return providerConfigState;
  });
  ipcMain.handle('provider-config:launch-codex-auth', async () => {
    const codexLoginUrl = 'https://chatgpt.com';
    if (process.platform === 'win32') {
      const codexCliPath = await resolveCodexCliForLogin();
      const message = [
        codexCliPath
          ? 'Codex CLI 로그인 창을 열었습니다. 브라우저 인증을 끝내면 앱이 ~/.codex/auth.json 세션을 사용합니다.'
          : 'Codex CLI를 찾지 못했습니다. Codex 앱/CLI를 설치한 뒤 다시 시도하세요.',
        '',
        '1. 열린 터미널에서 Codex 로그인 진행',
        '2. 브라우저 인증 완료',
        '3. 완료 후 앱에서 연결 확인 다시 실행'
      ].join('\n');

      dialog.showMessageBox({
        type: 'info',
        title: 'Codex 로그인 안내',
        message: 'Codex CLI 로그인 후 앱이 세션을 재사용합니다.',
        detail: message,
        buttons: ['확인']
      }).catch(() => undefined);

      if (!codexCliPath) {
        await shell.openExternal(codexLoginUrl);
        return { ok: false, detail: 'Codex CLI를 찾지 못했습니다. Codex CLI 설치 후 다시 시도하세요.' };
      }

      const status = await getCodexLoginStatus(codexCliPath);
      if (status.loggedIn) {
        return { ok: true, detail: `Codex auth는 이미 로그인되어 있습니다. (${status.detail}) 연결 테스트를 눌러 번역까지 확인하세요.` };
      }

      launchCodexLoginTerminal(codexCliPath);
      await shell.openExternal('https://auth.openai.com/codex/device');
      return { ok: true, detail: 'Codex 장치 인증 페이지와 PowerShell 로그인 창을 열었습니다. PowerShell에 표시된 1회용 코드를 웹페이지에 입력한 뒤 연결 테스트를 눌러 주세요.' };
    }

    await shell.openExternal(codexLoginUrl);
    return { ok: true, detail: '브라우저에서 ChatGPT를 열었습니다. Codex CLI 로그인 후 다시 연결 확인을 하세요.' };
  });
  ipcMain.handle('provider-config:probe-translation', async (_event, args: { provider?: TranslationProviderId; text?: string } | undefined) => {
    const provider = args?.provider ?? 'auto';
    const text = args?.text?.trim() || 'これは日本語のテスト音声です。';
    const previousEnv = { ...process.env };
    Object.assign(process.env, buildWorkerEnv(providerConfigState));
    const result = await runTranslationProbe(provider, text);
    process.env = previousEnv;

    if (result.success) {
      return {
        ok: true,
        detail: `${result.providerLabel} 연결 확인이 끝났습니다.`,
        translatedText: result.translatedText
      };
    }

    return {
      ok: false,
      detail: result.error ?? `${result.providerLabel} 연결 확인에 실패했습니다.`,
      translatedText: null
    };
  });
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await shell.openExternal(url);
    return true;
  });
  ipcMain.on('debug:permission-trace', (_event, payload: Record<string, unknown>) => {
    void debug('trace.permission', payload);
  });
  ipcMain.handle('permissions:request-microphone', async () => {
    if (process.platform !== 'darwin') {
      return { ok: false, detail: '이 권한 요청 흐름은 현재 macOS에서만 지원됩니다.', status: 'unsupported' };
    }

    const permissionContext = getMicrophonePermissionContext();
    const plistInfo = await readMacInfoPlistUsageDescription();
    const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
    await debug('main.ipc.permissions.request-microphone.enter', {
      ...permissionContext,
      plistInfo,
      currentStatus
    });
    if (currentStatus === 'granted') {
      await debug('main.ipc.permissions.request-microphone.short-circuit', {
        reason: 'already-granted',
        currentStatus
      });
      return { ok: true, detail: '마이크 권한이 이미 허용되어 있습니다.', status: currentStatus };
    }

    let granted = false;
    let askError: unknown = null;
    try {
      await debug('main.ipc.permissions.request-microphone.ask.before', {
        statusBeforeAsk: currentStatus
      });
      granted = await systemPreferences.askForMediaAccess('microphone');
      await debug('main.ipc.permissions.request-microphone.ask.after', {
        granted
      });
    } catch (error) {
      askError = error;
      await debug('main.ipc.permissions.request-microphone.ask.error', {
        error
      });
    }

    const nextStatus = systemPreferences.getMediaAccessStatus('microphone');
    const fallbackTriggered = nextStatus === 'denied' || nextStatus === 'restricted';
    await debug('main.ipc.permissions.request-microphone.result', {
      granted,
      nextStatus,
      askError,
      fallbackTriggered
    });
    if ((granted || nextStatus === 'granted') && !askError) {
      return { ok: true, detail: '마이크 권한 요청을 마쳤습니다. 앱을 다시 시작하면 장치 확인이 바로 이어집니다.', status: nextStatus };
    }

    if (fallbackTriggered) {
      const openedSettings = await openMacMicrophonePrivacySettings();
      await debug('main.ipc.permissions.request-microphone.fallback.settings', {
        openedSettings,
        nextStatus
      });
    } else {
      await debug('main.ipc.permissions.request-microphone.fallback.skipped', {
        nextStatus
      });
    }

    return {
      ok: false,
      detail: askError instanceof Error
        ? `마이크 권한 요청 호출이 실패했습니다: ${askError.message}`
        : buildMicrophonePermissionDetail(nextStatus, true),
      status: nextStatus
    };
  });
  ipcMain.handle('permissions:open-microphone-settings', async () => {
    const opened = await openMacMicrophonePrivacySettings();
    return {
      ok: opened,
      detail: opened
        ? '시스템 설정의 개인정보 보호 > 마이크를 열었습니다.'
        : '이 동작은 현재 macOS에서만 지원됩니다.'
    };
  });
  ipcMain.handle('permissions:open-screen-capture-settings', async () => {
    const opened = await openMacScreenCapturePrivacySettings();
    return {
      ok: opened,
      detail: opened
        ? '시스템 설정의 개인정보 보호 > 화면 및 시스템 오디오 녹음을 열었습니다.'
        : '이 동작은 현재 macOS에서만 지원됩니다.'
    };
  });

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  expectedWorkerExit = true;
  if (runtimeWorker && !runtimeWorker.killed) {
    runtimeWorker.kill();
  }
});
