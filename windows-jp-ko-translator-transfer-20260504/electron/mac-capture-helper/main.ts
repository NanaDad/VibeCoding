import { app, BrowserWindow, ipcMain } from 'electron';

let helperWindow: BrowserWindow | null = null;
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const segmentDirectory = process.env.MACOS_SYSTEM_AUDIO_SEGMENT_DIR?.trim();
const timesliceMs = Number.parseInt(process.env.MACOS_SYSTEM_AUDIO_TIMESLICE_MS ?? '', 10);

function emit(event: string, payload: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ source: 'mac-system-audio-helper', event, timestamp: new Date().toISOString(), ...payload }));
}

async function writeSegment(index: number, buffer: Buffer) {
  if (!segmentDirectory) {
    throw new Error('Segment directory is missing.');
  }

  await mkdir(segmentDirectory, { recursive: true });
  const filePath = path.join(segmentDirectory, `chunk-${String(index).padStart(5, '0')}.webm`);
  const tempPath = `${filePath}.part`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, filePath);
  return filePath;
}

async function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  const win = new BrowserWindow({
    show: true,
    width: 440,
    height: 180,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'JP-KO Translator System Audio Helper',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  helperWindow = win;

  emit('window-created', {
    preloadPath,
    url: win.webContents.getURL() || null
  });

  win.webContents.on('did-finish-load', () => {
    emit('did-finish-load', {
      url: win.webContents.getURL()
    });
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    emit('error', {
      phase: 'did-fail-load',
      errorCode,
      errorDescription,
      validatedURL
    });
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    emit('renderer-console', {
      level,
      message,
      line,
      sourceId
    });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    emit('error', {
      phase: 'render-process-gone',
      details
    });
  });

  ipcMain.handle('mac-system-audio:write-segment', async (_event, payload: { index: number; buffer: Uint8Array }) => {
    const filePath = await writeSegment(payload.index, Buffer.from(payload.buffer));
    emit('segment-written', { index: payload.index, filePath });
    return { ok: true, filePath };
  });

  ipcMain.on('mac-system-audio:status', (_event, payload: Record<string, unknown>) => {
    emit('status', payload);
    if (payload.phase === 'ready') {
      win.hide();
    }
  });

  ipcMain.on('mac-system-audio:error', (_event, payload: Record<string, unknown>) => {
    emit('error', payload);
  });

  const html = '<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:18px;background:#111827;color:#f9fafb"><h2 style="margin:0 0 10px;font-size:16px">macOS 시스템 오디오 연결 중…</h2><p style="margin:0;font-size:13px;line-height:1.5;color:#d1d5db">처음 한 번은 macOS 화면 및 시스템 오디오 권한 승인 또는 캡처 선택 창이 나타날 수 있습니다. 승인되면 이 창은 자동으로 숨겨집니다.</p></body></html>';
  const helperHtmlDirectory = segmentDirectory ?? app.getPath('temp');
  await mkdir(helperHtmlDirectory, { recursive: true });
  const helperHtmlPath = path.join(helperHtmlDirectory, 'mac-system-audio-helper.html');
  await writeFile(helperHtmlPath, html, 'utf8');
  const helperUrl = pathToFileURL(helperHtmlPath);
  helperUrl.searchParams.set('timesliceMs', String(Number.isFinite(timesliceMs) && timesliceMs >= 500 ? timesliceMs : 4000));
  emit('loading-url', {
    helperUrl: helperUrl.toString()
  });
  await win.loadURL(helperUrl.toString());
}

app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

void app.whenReady().then(async () => {
  if (!segmentDirectory) {
    emit('fatal', { message: 'MACOS_SYSTEM_AUDIO_SEGMENT_DIR is missing.' });
    app.exit(1);
    return;
  }

  emit('boot', {
    segmentDirectory,
    timesliceMs: Number.isFinite(timesliceMs) && timesliceMs >= 500 ? timesliceMs : 4000
  });

  try {
    await createWindow();
  } catch (error) {
    emit('fatal', {
      message: error instanceof Error ? error.message : String(error)
    });
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // Keep helper alive until parent stops it.
});

app.on('before-quit', () => {
  helperWindow = null;
});
