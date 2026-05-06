import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { CaptureSnapshot, HostPlatform } from '../shared/runtime-contract.js';

const execFileAsync = promisify(execFile);

export interface LiveTranscriptChunk {
  id: string;
  text: string;
  finalized: boolean;
}

export interface LiveCaptureHooks {
  onCaptureReady: (detail: { deviceLabel: string; backendLabel: string; command: string }) => Promise<void> | void;
  onCaptureExit: (message: string) => Promise<void> | void;
  onCaptureError: (message: string) => Promise<void> | void;
}

export interface LiveAudioSttProviderOptions {
  externalInput?: boolean;
}

function stripTerminalControl(value: string) {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '\n');
}

function getWhisperStreamExecutablePath() {
  const explicit = process.env.WHISPER_STREAM_PATH?.trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const candidates = [
    ...getResourceRoots().map((root) => path.join(root, 'bin', process.platform, process.arch, 'stream.exe')),
    ...getResourceRoots().map((root) => path.join(root, 'bin', process.platform, 'x64', 'stream.exe')),
    ...getResourceRoots().map((root) => path.join(root, 'b', 'wx', 'stream.exe')),
    path.join(process.cwd(), 'vendor', 'bin', process.platform, process.arch, 'stream.exe'),
    path.join(process.cwd(), 'vendor', 'bin', process.platform, 'x64', 'stream.exe'),
    path.join(process.cwd(), 'vendor', 'bin', 'win32', 'x64', 'stream.exe')
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function summarizeFfmpegWindowsError(stderr: string) {
  const compact = stderr.replace(/\s+/g, ' ').trim();
  const lower = compact.toLowerCase();
  const excerpt = compact.length > 320 ? `${compact.slice(0, 317)}...` : compact;

  if (!compact) {
    return { classification: 'unknown', summary: 'ffmpeg가 이유를 남기지 않고 종료됐습니다.', excerpt: null };
  }
  if (lower.includes('permission denied') || lower.includes('access is denied')) {
    return { classification: 'permission-denied', summary: '오디오 캡처 접근이 거부됐습니다.', excerpt };
  }
  if (lower.includes('device not found') || lower.includes('could not find audio device') || lower.includes('no such device')) {
    return { classification: 'device-not-found', summary: 'Windows 오디오 출력 장치를 찾지 못했습니다.', excerpt };
  }
  if (lower.includes('invalid argument') || lower.includes('[in#0') || lower.includes('could not open input') || lower.includes('i/o error')) {
    return { classification: 'input-open-failed', summary: 'ffmpeg가 Windows 오디오 입력을 열지 못했습니다.', excerpt };
  }
  return { classification: 'unknown', summary: 'Windows 오디오 캡처가 실패했습니다.', excerpt };
}

interface CaptureCommand {
  readonly backendLabel: string;
  readonly deviceLabel: string;
  readonly command: string;
  readonly args: string[];
}

interface MacSystemAudioHelperCommand {
  readonly backendLabel: string;
  readonly deviceLabel: string;
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

interface MacCaptureHelperReadyPayload {
  event?: string;
  message?: string;
  name?: string;
  backend?: string;
  backendLabel?: string;
  deviceLabel?: string;
  aggregateDeviceUID?: string;
  aggregateDeviceName?: string;
  outputDeviceUID?: string;
  outputDeviceName?: string;
  outputDirectory?: string;
}

interface MacAudioDevice {
  index: string;
  label: string;
}

interface MacAudioDiagnostics {
  devices: MacAudioDevice[];
  selectedDevice: MacAudioDevice | null;
  requestedDevice: string | null;
  inputDeviceCount: number;
  virtualDeviceCount: number;
}

interface WindowsAudioDevice {
  id: string;
  label: string;
  kind: 'render' | 'capture' | 'unknown';
  isLoopback: boolean;
  isDefault: boolean;
}

interface WindowsAudioDiagnostics {
  devices: WindowsAudioDevice[];
  selectedDevice: WindowsAudioDevice | null;
  requestedDevice: string | null;
}

export interface LiveCaptureProbeResult {
  platform: HostPlatform;
  toolchain: {
    ffmpeg: string;
    whisper: string;
  };
  requestedDevice: string | null;
  devices: Array<{
    index: string;
    label: string;
  }>;
  ready: boolean;
  readyDetail: {
    deviceLabel: string;
    backendLabel: string;
    command: string;
  } | null;
  chunkCount: number;
  transcriptPreview: string | null;
  errors: string[];
  exitedUnexpectedly: boolean;
}

interface WhisperCommand {
  readonly command: string;
  readonly args: string[];
}

interface ResolvedToolchain {
  ffmpeg: string;
  whisper: string;
  whisperModel: string | null;
}

interface PythonRuntime {
  command: string;
  args: string[];
}

interface DistilBackend {
  runtime: PythonRuntime;
  modelPath: string;
  scriptPath: string;
}

function getCommandLookupBinary() {
  return process.platform === 'win32' ? 'where' : 'which';
}

async function resolveExecutableFromPath(name: string) {
  const result = await execFileAsync(getCommandLookupBinary(), [name], {
    timeout: 5_000,
    windowsHide: true
  }).catch(() => null);

  return result?.stdout
    ?.split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean)
    ?? null;
}

function quoteArg(value: string) {
  if (!/[^\w./:-]/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function getSegmentSeconds() {
  const raw = Number.parseInt(process.env.TRANSLATOR_CAPTURE_SEGMENT_SECONDS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 2 || raw > 15) {
    return 4;
  }
  return raw;
}

function getWhisperModel() {
  return process.env.WHISPER_MODEL?.trim() || 'turbo';
}

function getExplicitWhisperModelPath() {
  return process.env.WHISPER_MODEL_PATH?.trim() || null;
}

function isWhisperCppBinary(command: string) {
  return /(?:whisper(?:-cli)?|main)(?:\.exe)?$/i.test(path.basename(command));
}

function getWhisperThreads() {
  const raw = Number.parseInt(process.env.WHISPER_THREADS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return Math.max(1, Math.min(4, os.cpus().length || 1));
  }
  return raw;
}

function getWhisperLanguage() {
  return process.env.WHISPER_LANGUAGE?.trim() || 'Japanese';
}

function getPreferredSttBackend() {
  return process.env.TRANSLATOR_STT_BACKEND?.trim() || 'auto';
}

function getMacAudioDevice() {
  return process.env.MACOS_TRANSLATOR_CAPTURE_DEVICE?.trim() || ':0';
}

function normalizeMacDeviceLabel(label: string) {
  return label
    .replace(/\s*\(.*?\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isLikelyVirtualMacInput(label: string) {
  return /(blackhole|loopback|background music|soundflower|vb-?cable|multi-output|aggregate|rogue amoeba|macfuse)/i.test(label);
}

function rankMacAudioDevice(device: MacAudioDevice) {
  const label = device.label;
  let score = 0;
  if (isLikelyVirtualMacInput(label)) score += 100;
  if (/blackhole/i.test(label)) score += 30;
  if (/loopback/i.test(label)) score += 20;
  if (/background music/i.test(label)) score += 15;
  if (/built-?in|internal|microphone|mic|macbook/i.test(label)) score -= 5;
  return score;
}

function resolveMacAudioDevice(devices: MacAudioDevice[], requestedDevice: string | null) {
  if (devices.length === 0) {
    return null;
  }

  if (requestedDevice && requestedDevice !== ':0') {
    const exact = devices.find((device) => `:${device.index}` === requestedDevice || device.label === requestedDevice);
    if (exact) {
      return exact;
    }

    const normalizedRequested = normalizeMacDeviceLabel(requestedDevice.replace(/^:/, ''));
    return devices.find((device) => normalizeMacDeviceLabel(device.label) === normalizedRequested) ?? null;
  }

  const ranked = [...devices].sort((left, right) => rankMacAudioDevice(right) - rankMacAudioDevice(left));
  return ranked[0] ?? devices[0];
}

function formatMacAudioSelectionError(diagnostics: MacAudioDiagnostics) {
  const { devices, requestedDevice, virtualDeviceCount } = diagnostics;
  if (devices.length === 0) {
    return 'macOS가 현재 이 앱에 노출한 오디오 입력 장치가 없습니다. 권한 문제라기보다 입력 장치 목록이 비어 있는 상태입니다.';
  }

  if (requestedDevice && requestedDevice !== ':0') {
    return `설정한 mac 오디오 입력(${requestedDevice})을 찾지 못했습니다. 현재 입력 ${devices.length}개만 확인됐습니다.`;
  }

  if (virtualDeviceCount === 0) {
    return '현재 구현은 mac 시스템 내부 소리를 직접 못 받고, 입력 장치만 읽고 있습니다. 이 경로 자체를 바꿔야 합니다.';
  }

  return '현재 구현은 mac 입력 장치 선택까지만 되어 있고, 내부 오디오 직접 캡처 경로는 아직 없습니다.';
}

function getWindowsAudioDevice() {
  return process.env.WINDOWS_TRANSLATOR_CAPTURE_DEVICE?.trim() || 'default';
}

function normalizeWindowsDeviceToken(value: string) {
  return value
    .replace(/^audio=/i, '')
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isLikelyManualWindowsVirtualDevice(label: string) {
  return /(stereo mix|vb-?cable|virtual|loopback cable|cable output|voicemeeter|line \d)/i.test(label);
}

export async function probeWindowsAudioDevices(ffmpegPath?: string) {
  const command = ffmpegPath ?? await resolveExecutable('ffmpeg');
  if (!command) {
    throw new Error(formatToolchainError('ffmpeg'));
  }

  const result = await execFileAsync(command, [
    '-hide_banner',
    '-f',
    'wasapi',
    '-list_devices',
    'true',
    '-i',
    'dummy'
  ], {
    timeout: 10_000,
    windowsHide: true
  }).catch((error: { stdout?: string; stderr?: string } | null) => error ?? null);

  const rawOutput = [result?.stdout ?? '', result?.stderr ?? ''].join('\n');
  const devices: WindowsAudioDevice[] = [];
  const seen = new Set<string>();

  for (const line of rawOutput.split(/\r?\n/g)) {
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
    if (quoted.length === 0) {
      continue;
    }

    const lower = line.toLowerCase();
    const kind: WindowsAudioDevice['kind'] = lower.includes('loopback') || lower.includes('render') || lower.includes('output')
      ? 'render'
      : lower.includes('capture') || lower.includes('input')
        ? 'capture'
        : 'unknown';

    for (const label of quoted) {
      const key = normalizeWindowsDeviceToken(label);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      devices.push({
        id: label,
        label,
        kind,
        isLoopback: /loopback/i.test(line) || /\(loopback\)/i.test(label),
        isDefault: /default/i.test(line)
      });
    }
  }

  return devices;
}

export async function probeWindowsDshowAudioDevices(ffmpegPath?: string) {
  const command = ffmpegPath ?? await resolveExecutable('ffmpeg');
  if (!command) {
    throw new Error(formatToolchainError('ffmpeg'));
  }

  const result = await execFileAsync(command, [
    '-hide_banner',
    '-f',
    'dshow',
    '-list_devices',
    'true',
    '-i',
    'dummy'
  ], {
    timeout: 10_000,
    windowsHide: true
  }).catch((error: { stdout?: string; stderr?: string } | null) => error ?? null);

  const rawOutput = [result?.stdout ?? '', result?.stderr ?? ''].join('\n');
  const devices: WindowsAudioDevice[] = [];
  let inAudioSection = false;

  for (const line of rawOutput.split(/\r?\n/g)) {
    if (/DirectShow audio devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) {
      const inlineAudioMatch = line.match(/"([^"]+)"\s+\(audio\)/i);
      if (!inlineAudioMatch?.[1]) {
        continue;
      }
      const label = inlineAudioMatch[1].trim();
      devices.push({
        id: label,
        label,
        kind: isLikelyManualWindowsVirtualDevice(label) || /stereo mix|what u hear|wave out/i.test(label) ? 'render' : 'capture',
        isLoopback: /stereo mix|what u hear|wave out|loopback|virtual-audio-capturer/i.test(label),
        isDefault: false
      });
      continue;
    }
    const match = line.match(/"([^"]+)"/);
    if (!match?.[1]) {
      continue;
    }
    const label = match[1].trim();
    devices.push({
      id: label,
      label,
      kind: isLikelyManualWindowsVirtualDevice(label) || /stereo mix|what u hear|wave out/i.test(label) ? 'render' : 'capture',
      isLoopback: /stereo mix|what u hear|wave out|loopback|virtual-audio-capturer/i.test(label),
      isDefault: false
    });
  }

  return devices;
}

function rankWindowsAudioDevice(device: WindowsAudioDevice) {
  let score = 0;
  if (device.kind === 'render') score += 100;
  if (device.isLoopback) score += 80;
  if (device.isDefault) score += 40;
  if (isLikelyManualWindowsVirtualDevice(device.label)) score -= 30;
  if (/speaker|headphone|headset|realtek|output/i.test(device.label)) score += 10;
  if (/microphone|mic|input/i.test(device.label)) score -= 50;
  return score;
}

function resolveWindowsAudioDevice(devices: WindowsAudioDevice[], requestedDevice: string | null) {
  if (requestedDevice && requestedDevice !== 'default') {
    const normalizedRequested = normalizeWindowsDeviceToken(requestedDevice);
    return devices.find((device) => normalizeWindowsDeviceToken(device.id) === normalizedRequested || normalizeWindowsDeviceToken(device.label) === normalizedRequested) ?? null;
  }

  if (devices.length === 0) {
    return null;
  }

  const ranked = [...devices].sort((left, right) => rankWindowsAudioDevice(right) - rankWindowsAudioDevice(left));
  return ranked.find((device) => device.kind === 'render' || device.isLoopback) ?? ranked[0] ?? null;
}

function formatWindowsAudioSelectionError(diagnostics: WindowsAudioDiagnostics) {
  const { devices, requestedDevice } = diagnostics;
  if (devices.length === 0) {
    return 'Windows 재생 장치 목록을 읽지 못했습니다. 기본 출력 장치가 정상인지 확인한 뒤 다시 시도하세요.';
  }

  if (requestedDevice && requestedDevice !== 'default') {
    return `설정한 Windows 캡처 장치(${requestedDevice})를 찾지 못했습니다. 기본값으로 비워 두면 현재 기본 출력 장치를 자동으로 따라갑니다.`;
  }

  return 'Windows 기본 출력 장치를 loopback 대상으로 고르지 못했습니다. 가상 장치 대신 기본 스피커/헤드폰 출력을 확인하세요.';
}

function formatWindowsDshowLoopbackMissingError(devices: WindowsAudioDevice[]) {
  const names = devices.map((device) => device.label).join(', ') || '없음';
  return [
    '현재 번들 ffmpeg는 WASAPI loopback을 지원하지 않아 DirectShow 캡처로 대체했습니다.',
    '하지만 DirectShow에서 Stereo Mix, What U Hear, virtual-audio-capturer 같은 재생 loopback 장치를 찾지 못했습니다.',
    `감지된 DirectShow 오디오 장치: ${names}`,
    'Windows 시스템 소리를 직접 받으려면 WASAPI 지원 캡처 경로가 필요하거나, Stereo Mix/가상 오디오 캡처 장치를 활성화해야 합니다.'
  ].join(' ');
}

function getExecutableCandidates(name: 'ffmpeg' | 'whisper') {
  if (name === 'ffmpeg') {
    return process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  }
  return process.platform === 'win32' ? ['whisper-cli.exe', 'whisper.exe', 'main.exe'] : ['whisper', 'whisper-cli', 'main'];
}

function getExplicitExecutablePath(name: 'ffmpeg' | 'whisper') {
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'WHISPER_PATH';
  return process.env[envKey]?.trim() || null;
}

function getResourceRoots() {
  const roots = [
    process.resourcesPath,
    process.cwd(),
    path.join(process.cwd(), 'resources'),
    path.dirname(process.execPath)
  ].filter((value): value is string => Boolean(value));
  return [...new Set(roots)];
}

function getBundledDistilModelPath() {
  const explicit = process.env.DISTIL_WHISPER_MODEL_PATH?.trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const candidates = [
    ...getResourceRoots().map((root) => path.join(root, 'models', process.platform, process.arch, 'distil-large-v3-ct2')),
    path.join(process.cwd(), 'vendor', 'models', process.platform, process.arch, 'distil-large-v3-ct2')
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getBundledTranscribeScriptPath() {
  const candidates = [
    ...getResourceRoots().map((root) => path.join(root, 'python', 'transcribe_distil_faster_whisper.py')),
    path.join(process.cwd(), 'scripts', 'transcribe_distil_faster_whisper.py')
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getBundledPythonCommand() {
  const candidates = process.platform === 'win32'
    ? [
        ...getResourceRoots().map((root) => path.join(root, 'python', process.platform, process.arch, 'Scripts', 'python.exe')),
        path.join(process.cwd(), 'vendor', 'python', process.platform, process.arch, 'Scripts', 'python.exe')
      ]
    : [
        ...getResourceRoots().map((root) => path.join(root, 'python', process.platform, process.arch, 'bin', 'python3')),
        ...getResourceRoots().map((root) => path.join(root, 'python', process.platform, process.arch, 'bin', 'python')),
        path.join(process.cwd(), 'vendor', 'python', process.platform, process.arch, 'bin', 'python3'),
        path.join(process.cwd(), 'vendor', 'python', process.platform, process.arch, 'bin', 'python')
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function resolvePythonCommand() {
  const bundled = getBundledPythonCommand();
  if (bundled) {
    return { command: bundled, args: [] };
  }

  const fromPath = await resolveExecutableFromPath(process.platform === 'win32' ? 'python.exe' : 'python3');
  if (fromPath) {
    return { command: fromPath, args: [] };
  }

  if (process.platform !== 'win32') {
    const alt = await resolveExecutableFromPath('python');
    if (alt) {
      return { command: alt, args: [] };
    }
  }

  return null;
}

async function resolveDistilBackend(): Promise<DistilBackend | null> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return null;
  }

  const modelPath = getBundledDistilModelPath();
  const scriptPath = getBundledTranscribeScriptPath();
  const runtime = await resolvePythonCommand();
  if (!modelPath || !scriptPath || !runtime) {
    return null;
  }

  return {
    runtime,
    modelPath,
    scriptPath
  };
}

function getBundledExecutableCandidatePaths(name: 'ffmpeg' | 'whisper') {
  const executables = getExecutableCandidates(name);
  const archCandidates = [...new Set([process.arch, 'arm64', 'x64'])];
  const candidates = executables.flatMap((executable) => [
    ...getResourceRoots().flatMap((root) => [
      ...archCandidates.map((arch) => path.join(root, 'bin', process.platform, arch, executable)),
      path.join(root, 'bin', executable),
      path.join(root, 'b', 'wx', executable)
    ]),
    ...archCandidates.map((arch) => path.join(process.cwd(), 'vendor', 'bin', process.platform, arch, executable)),
    ...archCandidates.map((arch) => path.join(process.cwd(), 'bin', process.platform, arch, executable)),
    path.join(process.cwd(), 'vendor', 'bin', 'win32', 'x64', executable)
  ]);

  return [...new Set(candidates)];
}

async function resolveExecutable(name: 'ffmpeg' | 'whisper') {
  const explicit = getExplicitExecutablePath(name);
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  for (const candidate of getBundledExecutableCandidatePaths(name)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const executable of getExecutableCandidates(name)) {
    const resolved = await resolveExecutableFromPath(executable);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function ffmpegSupportsInputDevice(command: string, inputDevice: string) {
  const result = await execFileAsync(command, ['-hide_banner', '-devices'], {
    timeout: 5_000,
    windowsHide: true
  }).catch((error: { stdout?: string; stderr?: string } | null) => error ?? null);
  const output = [result?.stdout ?? '', result?.stderr ?? ''].join('\n');
  return new RegExp(`\\b${inputDevice}\\b`, 'i').test(output);
}

function resolveBundledModelPath() {
  const explicit = getExplicitWhisperModelPath();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const names = ['ggml-base.bin', 'ggml-turbo.bin'];
  const candidates = names.flatMap((name) => [
    ...getResourceRoots().map((root) => path.join(root, 'bin', process.platform, process.arch, name)),
    ...getResourceRoots().map((root) => path.join(root, 'bin', process.platform, 'x64', name)),
    ...getResourceRoots().map((root) => path.join(root, 'bin', process.platform, 'arm64', name)),
    ...getResourceRoots().map((root) => path.join(root, 'bin', name)),
    path.join(process.cwd(), 'vendor', 'bin', process.platform, process.arch, name)
  ]);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function hasBundledModelForPlatform(platform: HostPlatform) {
  const names = ['ggml-base.bin', 'ggml-turbo.bin'];
  const archCandidates = platform === 'win32' ? ['x64', process.arch] : [process.arch, 'arm64', 'x64'];
  const candidates = names.flatMap((name) => [
    ...getResourceRoots().flatMap((root) => archCandidates.map((arch) => path.join(root, 'bin', platform, arch, name))),
    ...archCandidates.map((arch) => path.join(process.cwd(), 'vendor', 'bin', platform, arch, name))
  ]);
  return candidates.some((candidate) => existsSync(candidate));
}

function formatMissingModelError(platform: HostPlatform) {
  if (getExplicitWhisperModelPath()) {
    return '지정한 음성 인식 모델 파일을 찾지 못했습니다. 설정의 모델 경로를 확인한 뒤 다시 시도하세요.';
  }
  if (platform === 'darwin' && hasBundledModelForPlatform('win32') && !hasBundledModelForPlatform('darwin')) {
    return '현재 mac 호스트에는 실오디오 검증용 ggml 모델이 없습니다. mac용 모델 경로를 설정하거나 mac용 번들 리소스를 추가하세요.';
  }
  if (platform === 'win32' && hasBundledModelForPlatform('darwin') && !hasBundledModelForPlatform('win32')) {
    return '현재 Windows 호스트에는 실오디오 검증용 ggml 모델이 없습니다. Windows용 모델 경로를 설정하거나 Windows용 번들 리소스를 추가하세요.';
  }
  return '음성 인식 모델 파일(ggml-base.bin)을 찾지 못했습니다. 압축을 다시 풀거나 모델 경로를 설정하세요.';
}

function formatToolchainError(name: 'ffmpeg' | 'whisper') {
  if (name === 'ffmpeg') {
    if (process.platform === 'win32') {
      return '오디오 캡처 도구(ffmpeg)를 열지 못했습니다. 앱을 다시 압축 해제한 뒤 다시 실행하세요.';
    }
    return '오디오 캡처 도구(ffmpeg)를 찾지 못했습니다. ffmpeg를 설치한 뒤 다시 실행하세요.';
  }

  if (process.platform === 'win32') {
    return '음성 인식 도구(whisper.cpp)를 찾지 못했습니다. 압축을 다시 풀고 실행하세요.';
  }

  return '음성 인식 도구(whisper)를 찾지 못했습니다. whisper를 설치한 뒤 다시 실행하세요.';
}

export async function probeMacAudioDevices(ffmpegPath?: string) {
  const command = ffmpegPath ?? await resolveExecutable('ffmpeg');
  if (!command) {
    throw new Error(formatToolchainError('ffmpeg'));
  }

  const result = await execFileAsync(command, [
    '-hide_banner',
    '-f',
    'avfoundation',
    '-list_devices',
    'true',
    '-i',
    ''
  ], {
    timeout: 10_000,
    windowsHide: true
  }).catch((error: { stdout?: string; stderr?: string } | null) => error ?? null);

  const rawOutput = [result?.stdout ?? '', result?.stderr ?? ''].join('\n');
  const devices: MacAudioDevice[] = [];
  const lines = rawOutput.split(/\r?\n/g);

  let inAudioSection = false;

  for (const line of lines) {
    if (line.includes('AVFoundation audio devices')) {
      inAudioSection = true;
      continue;
    }
    if (inAudioSection && line.includes('AVFoundation video devices')) {
      continue;
    }
    if (!inAudioSection) {
      continue;
    }
    const match = line.match(/\[([0-9]+)\]\s+(.+)$/);
    if (!match) {
      continue;
    }
    devices.push({
      index: match[1],
      label: match[2].trim()
    });
  }

  return devices;
}

async function createCaptureCommand(platform: HostPlatform, outputPattern: string, toolchain: ResolvedToolchain): Promise<CaptureCommand> {
  if (platform === 'win32') {
    const requestedDevice = getWindowsAudioDevice();
    const supportsWasapi = await ffmpegSupportsInputDevice(toolchain.ffmpeg, 'wasapi');
    const devices = supportsWasapi
      ? await probeWindowsAudioDevices(toolchain.ffmpeg).catch(() => [])
      : await probeWindowsDshowAudioDevices(toolchain.ffmpeg).catch(() => []);
    const selectedDevice = resolveWindowsAudioDevice(devices, requestedDevice);
    if (!supportsWasapi && !selectedDevice?.isLoopback) {
      throw new Error(formatWindowsDshowLoopbackMissingError(devices));
    }
    if (!selectedDevice && devices.length > 0 && requestedDevice !== 'default') {
      throw new Error(formatWindowsAudioSelectionError({
        devices,
        selectedDevice,
        requestedDevice
      }));
    }

    const inputDevice = selectedDevice?.id ?? requestedDevice;
    const normalizedInputDevice = inputDevice.toLowerCase() === 'default' ? 'default' : `audio=${inputDevice}`;
    const dshowInputDevice = selectedDevice?.id ? `audio=${selectedDevice.id}` : 'audio=virtual-audio-capturer';
    const args = [
      '-hide_banner',
      '-loglevel',
      'level+info',
      '-fflags',
      '+genpts',
      '-thread_queue_size',
      '4096',
      '-f',
      supportsWasapi ? 'wasapi' : 'dshow',
      ...(supportsWasapi ? ['-loopback', '1'] : []),
      '-i',
      supportsWasapi ? normalizedInputDevice : dshowInputDevice,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'segment',
      '-segment_time',
      String(getSegmentSeconds()),
      '-reset_timestamps',
      '1',
      outputPattern
    ];

    return {
      backendLabel: supportsWasapi ? 'Windows WASAPI Loopback' : 'Windows DirectShow Audio',
      deviceLabel: selectedDevice?.label ?? (supportsWasapi && requestedDevice === 'default' ? 'Default Windows Output (WASAPI loopback)' : requestedDevice),
      command: toolchain.ffmpeg,
      args
    };
  }

  if (platform === 'darwin') {
    const requestedDevice = process.env.MACOS_TRANSLATOR_CAPTURE_DEVICE?.trim();
    if (!requestedDevice) {
      throw new Error('macOS CoreAudio tap aggregate 장치 이름을 아직 받지 못했습니다.');
    }

    return {
      backendLabel: 'macOS CoreAudio Tap',
      deviceLabel: requestedDevice,
      command: toolchain.ffmpeg,
      args: [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-f',
        'avfoundation',
        '-i',
        `:${requestedDevice}`,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        'segment',
        '-segment_time',
        String(getSegmentSeconds()),
        '-reset_timestamps',
        '1',
        outputPattern
      ]
    };
  }

  throw new Error(`Live capture is not supported on platform ${platform}.`);
}

function getMacScreenAudioHelperSourcePath() {
  const resourcePath = typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
    ? process.resourcesPath
    : null;

  const candidates = [
    path.join(process.cwd(), 'electron', 'native', 'macos-screen-audio-capture.swift'),
    resourcePath ? path.join(resourcePath, 'app.asar', 'electron', 'native', 'macos-screen-audio-capture.swift') : null,
    resourcePath ? path.join(resourcePath, 'electron', 'native', 'macos-screen-audio-capture.swift') : null
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function resolveMacScreenAudioHelperBinary() {
  const sourcePath = getMacScreenAudioHelperSourcePath();
  if (!sourcePath) {
    throw new Error('macOS ScreenCaptureKit helper 소스 파일을 찾지 못했습니다.');
  }

  const compiler = await resolveExecutableFromPath('swiftc') ?? await resolveExecutableFromPath('xcrun');
  if (!compiler) {
    throw new Error('macOS ScreenCaptureKit helper를 컴파일할 swiftc를 찾지 못했습니다. Xcode Command Line Tools를 설치하세요.');
  }

  const helperDirectory = path.join(os.tmpdir(), 'jp-ko-translator-native');
  await mkdir(helperDirectory, { recursive: true });
  const binaryPath = path.join(helperDirectory, 'macos-screen-audio-capture-helper');
  const args = path.basename(compiler) === 'xcrun'
    ? ['swiftc', sourcePath, '-o', binaryPath]
    : [sourcePath, '-o', binaryPath];

  await execFileAsync(compiler, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true
  }).catch((error: { stderr?: string; message?: string }) => {
    throw new Error(`macOS ScreenCaptureKit helper를 컴파일하지 못했습니다. ${error?.stderr?.trim() || error?.message || 'swiftc failed'}`);
  });

  return binaryPath;
}

async function createMacScreenAudioHelperCommand(outputDirectory: string): Promise<MacSystemAudioHelperCommand> {
  const helperBinary = await resolveMacScreenAudioHelperBinary();
  return {
    backendLabel: 'macOS ScreenCaptureKit Native',
    deviceLabel: 'System Audio (ScreenCaptureKit)',
    command: helperBinary,
    args: ['--output-dir', outputDirectory, '--segment-seconds', String(getSegmentSeconds())],
    env: {
      ...process.env
    }
  };
}

async function convertAudioForTranscription(sourcePath: string, toolchain: ResolvedToolchain, tempDirectory: string) {
  if (sourcePath.endsWith('.wav')) {
    return sourcePath;
  }

  const convertedPath = path.join(tempDirectory, `${path.basename(sourcePath, path.extname(sourcePath))}.wav`);
  await execFileAsync(toolchain.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    sourcePath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    convertedPath
  ], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true
  });

  return convertedPath;
}

function createWhisperCommand(audioPath: string, outputDirectory: string, toolchain: ResolvedToolchain): WhisperCommand {
  if (isWhisperCppBinary(toolchain.whisper)) {
    const modelPath = toolchain.whisperModel ?? getWhisperModel();
    return {
      command: toolchain.whisper,
      args: [
        '-m',
        modelPath,
        '-f',
        audioPath,
        '-l',
        'ja',
        '-oj',
        '-of',
        path.join(outputDirectory, path.basename(audioPath, path.extname(audioPath))),
        '-t',
        String(getWhisperThreads())
      ]
    };
  }

  return {
    command: toolchain.whisper,
    args: [
      '--model',
      getWhisperModel(),
      '--device',
      process.env.WHISPER_DEVICE?.trim() || 'cpu',
      '--task',
      'transcribe',
      '--language',
      getWhisperLanguage(),
      '--output_format',
      'json',
      '--output_dir',
      outputDirectory,
      '--threads',
      String(getWhisperThreads()),
      '--verbose',
      'False',
      audioPath
    ]
  };
}

async function readWhisperText(outputDirectory: string, audioPath: string) {
  const jsonPath = path.join(outputDirectory, `${path.basename(audioPath, path.extname(audioPath))}.json`);
  const raw = await readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { text?: string };
  return parsed.text?.trim() || null;
}

export async function verifyLiveCaptureToolchain(platform: HostPlatform): Promise<ResolvedToolchain> {
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`Live capture is not supported on ${platform}.`);
  }

  const ffmpeg = await resolveExecutable('ffmpeg');
  if (!ffmpeg) {
    throw new Error(formatToolchainError('ffmpeg'));
  }
  if (platform === 'win32'
    && !(await ffmpegSupportsInputDevice(ffmpeg, 'wasapi'))
    && !(await ffmpegSupportsInputDevice(ffmpeg, 'dshow'))) {
    throw new Error('번들된 ffmpeg가 Windows 오디오 입력 장치를 지원하지 않습니다. ffmpeg Windows 빌드를 다시 준비하세요.');
  }

  const preferredBackend = getPreferredSttBackend();
  if ((preferredBackend === 'auto' || preferredBackend === 'distil-faster-whisper') && platform === 'darwin' && process.arch === 'arm64') {
    const distilBackend = await resolveDistilBackend();
    if (distilBackend) {
      return {
        ffmpeg,
        whisper: `${distilBackend.runtime.command} ${distilBackend.runtime.args.join(' ')} :: distil-faster-whisper`,
        whisperModel: distilBackend.modelPath
      };
    }
    if (preferredBackend === 'distil-faster-whisper') {
      throw new Error('distil-large-v3 백엔드를 강제했지만, 번들 Python 런타임 또는 모델 디렉터리를 찾지 못했습니다.');
    }
  }

  const whisper = await resolveExecutable('whisper');
  if (!whisper) {
    throw new Error(formatToolchainError('whisper'));
  }

  const whisperModel = resolveBundledModelPath();
  if (isWhisperCppBinary(whisper) && !whisperModel) {
    throw new Error(formatMissingModelError(platform));
  }

  return {
    ffmpeg,
    whisper,
    whisperModel
  };
}

export async function runLiveCaptureProbe(
  platform: HostPlatform,
  options: {
    timeoutMs?: number;
  } = {}
): Promise<LiveCaptureProbeResult> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 8_000;
  const toolchain = await verifyLiveCaptureToolchain(platform);
  const devices = platform === 'darwin' ? [] : [];
  let ready = false;
  let exitedUnexpectedly = false;
  let transcriptPreview: string | null = null;
  let chunkCount = 0;
  let readyDetail: LiveCaptureProbeResult['readyDetail'] = null;
  const errors: string[] = [];
  const hooks: LiveCaptureHooks = {
    onCaptureReady: async () => undefined,
    onCaptureExit: async () => undefined,
    onCaptureError: async () => undefined
  };
  const provider = new LiveAudioSttProvider(platform, hooks);

  hooks.onCaptureReady = async (detail) => {
    ready = true;
    readyDetail = detail;
  };
  hooks.onCaptureExit = async (message) => {
    exitedUnexpectedly = true;
    errors.push(message);
  };
  hooks.onCaptureError = async (message) => {
    errors.push(message);
  };

  try {
    await provider.start(async (chunk) => {
      chunkCount += 1;
      if (!transcriptPreview && chunk.text.trim()) {
        transcriptPreview = chunk.text.trim();
      }
    });

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  } finally {
    await provider.stop().catch(() => undefined);
  }

  return {
    platform,
    toolchain,
    requestedDevice: platform === 'darwin' ? getMacAudioDevice() : platform === 'win32' ? getWindowsAudioDevice() : null,
    devices,
    ready,
    readyDetail,
    chunkCount,
    transcriptPreview,
    errors,
    exitedUnexpectedly
  };
}

export function applyLiveCaptureReadySnapshot(
  snapshot: CaptureSnapshot,
  detail: {
    backendLabel: string;
    deviceLabel: string;
    backend: CaptureSnapshot['backend'];
  }
): CaptureSnapshot {
  return {
    ...snapshot,
    phase: 'capturing',
    deviceLabel: detail.deviceLabel,
    backendLabel: detail.backendLabel,
    backend: detail.backend,
    lastError: null,
    guidance: `${detail.backendLabel}가 실제 입력선을 열었습니다. 현재 장치: ${detail.deviceLabel}`
  };
}

export class StreamingWhisperSttProvider {
  readonly key = 'live-capture.win32.whisper-stream';
  private readonly platform: HostPlatform;
  private readonly hooks: LiveCaptureHooks;
  private streamProcess: ChildProcess | null = null;
  private cancelled = false;
  private sequence = 0;
  private lastText = '';
  private stdoutBuffer = '';

  constructor(platform: HostPlatform, hooks: LiveCaptureHooks) {
    this.platform = platform;
    this.hooks = hooks;
  }

  async start(onChunk: (chunk: LiveTranscriptChunk) => Promise<void>) {
    if (this.platform !== 'win32') {
      throw new Error('whisper.cpp stream.exe STT is currently supported on Windows only.');
    }

    const toolchain = await verifyLiveCaptureToolchain(this.platform);
    const streamPath = getWhisperStreamExecutablePath();
    if (!streamPath) {
      throw new Error('whisper.cpp stream.exe를 찾지 못했습니다. Windows STT 준비 스크립트를 다시 실행하세요.');
    }

    const modelPath = toolchain.whisperModel ?? getWhisperModel();
    const args = [
      '-m',
      modelPath,
      '-l',
      'ja',
      '--step',
      process.env.WHISPER_STREAM_STEP_MS?.trim() || '1000',
      '--length',
      process.env.WHISPER_STREAM_LENGTH_MS?.trim() || '6000',
      '--keep',
      process.env.WHISPER_STREAM_KEEP_MS?.trim() || '1000',
      '-t',
      String(getWhisperThreads()),
      '-kc'
    ];

    const requestedDevice = process.env.WHISPER_STREAM_CAPTURE_DEVICE?.trim();
    if (requestedDevice) {
      args.push('-c', requestedDevice);
    }

    this.cancelled = false;
    this.streamProcess = spawn(streamPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env
      }
    });

    await this.hooks.onCaptureReady({
      deviceLabel: requestedDevice ? `SDL capture device #${requestedDevice}` : 'Default SDL capture device',
      backendLabel: 'Whisper.cpp Streaming STT',
      command: [streamPath, ...args].map(quoteArg).join(' ')
    });

    this.streamProcess.stdout?.on('data', (chunk) => {
      this.consumeStdout(String(chunk), onChunk);
    });

    this.streamProcess.stderr?.on('data', (chunk) => {
      const text = stripTerminalControl(String(chunk)).trim();
      if (/found \d+ capture devices|Capture device|obtained spec/i.test(text)) {
        void this.hooks.onCaptureReady({
          deviceLabel: requestedDevice ? `SDL capture device #${requestedDevice}` : 'Default SDL capture device',
          backendLabel: 'Whisper.cpp Streaming STT',
          command: [streamPath, ...args].map(quoteArg).join(' ')
        });
      }
    });

    this.streamProcess.once('error', (error) => {
      void this.hooks.onCaptureError(`whisper.cpp stream.exe를 시작하지 못했습니다. ${error.message}`);
    });

    this.streamProcess.once('exit', (code, signal) => {
      if (this.cancelled) {
        return;
      }
      void this.hooks.onCaptureExit(signal
        ? `whisper.cpp stream.exe가 ${signal}로 종료되었습니다.`
        : `whisper.cpp stream.exe가 code ${code ?? 'unknown'}로 종료되었습니다.`);
    });
  }

  async stop() {
    this.cancelled = true;
    if (this.streamProcess && !this.streamProcess.killed) {
      this.streamProcess.kill('SIGTERM');
    }
    this.streamProcess = null;
    this.stdoutBuffer = '';
    this.lastText = '';
  }

  private consumeStdout(raw: string, onChunk: (chunk: LiveTranscriptChunk) => Promise<void>) {
    this.stdoutBuffer += stripTerminalControl(raw);
    if (this.stdoutBuffer.length > 8000) {
      this.stdoutBuffer = this.stdoutBuffer.slice(-8000);
    }

    const parts = this.stdoutBuffer.split(/\n/g);
    this.stdoutBuffer = parts.pop() ?? '';
    for (const part of parts) {
      const text = part
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || /^start speaking$/i.test(text) || text === this.lastText) {
        continue;
      }
      this.lastText = text;
      this.sequence += 1;
      void onChunk({
        id: `stream-${Date.now()}-${this.sequence}`,
        text,
        finalized: false
      });
    }
  }
}

export class LiveAudioSttProvider {
  readonly key: string;
  private readonly platform: HostPlatform;
  private readonly hooks: LiveCaptureHooks;
  private readonly externalInput: boolean;
  private captureProcess: ChildProcess | null = null;
  private processingTimer: NodeJS.Timeout | null = null;
  private tempDirectory: string | null = null;
  private segmentDirectory: string | null = null;
  private processedFiles = new Set<string>();
  private cancelled = false;
  private sequence = 0;
  private isPolling = false;
  private toolchain: ResolvedToolchain | null = null;
  private distilBackend: DistilBackend | null = null;
  private macHelperProcess: ChildProcess | null = null;
  private onChunk: ((chunk: LiveTranscriptChunk) => Promise<void>) | null = null;
  private rollingTranscriptId: string | null = null;
  private lastExternalTranscriptText = '';

  constructor(platform: HostPlatform, hooks: LiveCaptureHooks, options: LiveAudioSttProviderOptions = {}) {
    this.platform = platform;
    this.hooks = hooks;
    this.externalInput = options.externalInput ?? false;
    this.key = this.externalInput ? `live-capture.${platform}.electron-mediarecorder+whisper` : `live-capture.${platform}.ffmpeg+whisper`;
  }

  async start(onChunk: (chunk: LiveTranscriptChunk) => Promise<void>) {
    this.toolchain = await verifyLiveCaptureToolchain(this.platform);
    this.distilBackend = await resolveDistilBackend();
    this.onChunk = onChunk;

    this.cancelled = false;
    this.tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'jp-ko-live-capture-'));
    this.segmentDirectory = path.join(this.tempDirectory, 'segments');
    await mkdir(this.segmentDirectory, { recursive: true });
    const outputPattern = path.join(this.segmentDirectory, 'chunk-%05d.wav');

    if (this.externalInput) {
      await this.hooks.onCaptureReady({
        deviceLabel: 'Electron system audio stream',
        backendLabel: 'Electron Desktop Audio Bridge',
        command: 'renderer MediaRecorder -> worker whisper'
      });
      return;
    }

    if (this.platform === 'darwin') {
      const helper = await createMacScreenAudioHelperCommand(this.segmentDirectory);
      this.macHelperProcess = spawn(helper.command, helper.args, {
        env: helper.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let captureStarted = false;

      this.macHelperProcess.stdout?.on('data', (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/g);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) {
            continue;
          }
          try {
            const payload = JSON.parse(trimmed) as MacCaptureHelperReadyPayload;
            if (payload.event === 'ready' && !captureStarted) {
              captureStarted = true;
              const deviceLabel = typeof payload.deviceLabel === 'string' ? payload.deviceLabel : helper.deviceLabel;
              void this.hooks.onCaptureReady({
                deviceLabel,
                backendLabel: typeof payload.backendLabel === 'string' ? payload.backendLabel : helper.backendLabel,
                command: [helper.command, ...helper.args].map(quoteArg).join(' ')
              });
            }
            if (payload.event === 'error') {
              const detail = [payload.message, payload.name].filter((value, index, array) => typeof value === 'string' && value.length > 0 && array.indexOf(value) === index).join(' ');
              void this.hooks.onCaptureError(`macOS ScreenCaptureKit native 시스템 오디오 캡처를 시작하지 못했습니다. ${detail || 'ScreenCaptureKit 상태를 확인하세요.'}`);
            }
          } catch {
            // ignore helper noise
          }
        }
      });

      this.macHelperProcess.stderr?.on('data', (chunk) => {
        stderrBuffer += String(chunk);
      });

      this.macHelperProcess.once('error', (error) => {
        void this.hooks.onCaptureError(`macOS ScreenCaptureKit helper를 시작하지 못했습니다. ${error.message}`);
      });

      this.macHelperProcess.once('exit', (code, signal) => {
        if (this.cancelled) {
          return;
        }
        const reason = stderrBuffer.trim() || (signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`);
        void this.hooks.onCaptureExit(`macOS ScreenCaptureKit helper가 중단됐습니다. ${reason}`);
      });
    } else {
      const capture = await createCaptureCommand(this.platform, outputPattern, this.toolchain);
      this.captureProcess = spawn(capture.command, capture.args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });

      let stderrBuffer = '';
      this.captureProcess.stderr?.on('data', (chunk) => {
        stderrBuffer += String(chunk);
        if (stderrBuffer.length > 12000) {
          stderrBuffer = stderrBuffer.slice(-12000);
        }
      });

      this.captureProcess.once('spawn', () => {
        // wait for first real segment before declaring capture ready
      });

      this.captureProcess.once('error', (error) => {
        void this.hooks.onCaptureError(`캡처를 시작하지 못했습니다. ${error.message}`);
      });

      this.captureProcess.once('exit', (code, signal) => {
        if (this.cancelled) {
          return;
        }
        const fallbackReason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
        if (this.platform === 'win32') {
          const parsed = summarizeFfmpegWindowsError(stderrBuffer);
          const reason = parsed.excerpt ? `${parsed.summary} ${parsed.excerpt}` : `${parsed.summary} ${fallbackReason}`;
          void this.hooks.onCaptureExit(`오디오 캡처가 중단됐습니다. [${parsed.classification}] ${reason}`);
          return;
        }
        const reason = stderrBuffer.trim() || fallbackReason;
        void this.hooks.onCaptureExit(`오디오 캡처가 중단됐습니다. ${reason}`);
      });
    }

    this.processingTimer = setInterval(() => {
      void this.pollSegments(onChunk);
    }, 1_000);
  }

  async ingestExternalChunk(data: Uint8Array, mimeType: string) {
    if (this.cancelled || !this.segmentDirectory || !this.onChunk) {
      return;
    }

    const extension = mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('mp4') || mimeType.includes('m4a')
        ? 'm4a'
        : 'webm';
    const filePath = path.join(this.segmentDirectory, `renderer-${Date.now()}-${this.sequence}.${extension}`);
    await writeFile(filePath, data);
    await this.pollSegments(this.onChunk);
  }

  async stop() {
    this.cancelled = true;
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    if (this.captureProcess && !this.captureProcess.killed) {
      this.captureProcess.kill('SIGTERM');
    }
    if (this.macHelperProcess && !this.macHelperProcess.killed) {
      this.macHelperProcess.kill('SIGTERM');
    }
    this.captureProcess = null;
    this.macHelperProcess = null;
    this.onChunk = null;
    this.rollingTranscriptId = null;
    this.lastExternalTranscriptText = '';
    if (this.tempDirectory) {
      await rm(this.tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    this.tempDirectory = null;
    this.segmentDirectory = null;
    this.processedFiles.clear();
  }

  private async pollSegments(onChunk: (chunk: LiveTranscriptChunk) => Promise<void>) {
    if (this.cancelled || this.isPolling || !this.segmentDirectory) {
      return;
    }

    this.isPolling = true;
    try {
      let files = (await readdir(this.segmentDirectory))
        .filter((file) => (file.endsWith('.wav') || file.endsWith('.webm') || file.endsWith('.m4a')) && !file.endsWith('.part'))
        .sort();

      if (this.externalInput) {
        const pendingFiles = files.filter((file) => !this.processedFiles.has(path.join(this.segmentDirectory!, file)));
        const staleFiles = pendingFiles.slice(0, -1);
        for (const staleFile of staleFiles) {
          const stalePath = path.join(this.segmentDirectory, staleFile);
          this.processedFiles.add(stalePath);
          await rm(stalePath, { force: true }).catch(() => undefined);
        }
        files = pendingFiles.slice(-1);
      }

      for (const file of files) {
        const fullPath = path.join(this.segmentDirectory, file);
        if (this.processedFiles.has(fullPath)) {
          continue;
        }
        this.processedFiles.add(fullPath);
        if (this.sequence === 0 && !this.externalInput) {
          await this.hooks.onCaptureReady({
            deviceLabel: this.platform === 'win32' ? 'Default Windows Output (WASAPI loopback)' : 'Live Audio Input',
            backendLabel: this.platform === 'win32' ? 'Windows WASAPI Loopback' : 'Live Audio Capture',
            command: this.captureProcess ? [this.captureProcess.spawnfile, ...(this.captureProcess.spawnargs?.slice(1) ?? [])].map(quoteArg).join(' ') : 'capture-process'
          });
        }
        const text = await this.transcribe(fullPath);
        if (!text) {
          continue;
        }
        if (this.externalInput && text === this.lastExternalTranscriptText) {
          continue;
        }
        if (this.externalInput) {
          this.lastExternalTranscriptText = text;
          this.rollingTranscriptId ??= `live-rolling-${Date.now()}`;
        }
        this.sequence += 1;
        await onChunk({
          id: this.externalInput ? this.rollingTranscriptId! : `live-${Date.now()}-${this.sequence}`,
          text,
          finalized: !this.externalInput
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.hooks.onCaptureError(`오디오 처리 중 문제가 생겼습니다. ${message}`);
    } finally {
      this.isPolling = false;
    }
  }

  private async transcribe(audioPath: string) {
    if (!this.tempDirectory || !this.toolchain) {
      return null;
    }

    let normalizedAudioPath = audioPath;

    try {
      normalizedAudioPath = await convertAudioForTranscription(audioPath, this.toolchain, this.tempDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.hooks.onCaptureError(`오디오 형식 변환에 실패했습니다. ${message}`);
      await rm(audioPath, { force: true }).catch(() => undefined);
      return null;
    }

    if (this.distilBackend && this.toolchain.whisper.includes('distil-faster-whisper')) {
      return this.transcribeWithDistilBackend(normalizedAudioPath, audioPath);
    }

    const outputDirectory = path.join(this.tempDirectory, `whisper-${path.basename(normalizedAudioPath, path.extname(normalizedAudioPath))}`);
    await mkdir(outputDirectory, { recursive: true });
    const whisper = createWhisperCommand(normalizedAudioPath, outputDirectory, this.toolchain);

    try {
      await execFileAsync(whisper.command, whisper.args, {
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
        env: {
          ...process.env,
          OMP_NUM_THREADS: String(getWhisperThreads())
        }
      });
      return await readWhisperText(outputDirectory, normalizedAudioPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.hooks.onCaptureError(`음성 인식에 실패했습니다. ${message}`);
      return null;
    } finally {
      await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (normalizedAudioPath !== audioPath) {
        await rm(normalizedAudioPath, { force: true }).catch(() => undefined);
      }
      await rm(audioPath, { force: true }).catch(() => undefined);
    }
  }

  private async transcribeWithDistilBackend(audioPath: string, originalAudioPath = audioPath) {
    if (!this.tempDirectory || !this.distilBackend) {
      return null;
    }

    const outputPath = path.join(this.tempDirectory, `${path.basename(audioPath, path.extname(audioPath))}.distil.json`);
    const runtimeArgs = [
      ...this.distilBackend.runtime.args,
      this.distilBackend.scriptPath,
      '--audio',
      audioPath,
      '--model-dir',
      this.distilBackend.modelPath,
      '--output',
      outputPath,
      '--language',
      'ja'
    ];

    try {
      await execFileAsync(this.distilBackend.runtime.command, runtimeArgs, {
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 16,
        windowsHide: true,
        env: {
          ...process.env,
          OMP_NUM_THREADS: String(getWhisperThreads())
        }
      });

      const raw = await readFile(outputPath, 'utf8');
      const parsed = JSON.parse(raw) as { text?: string };
      return parsed.text?.trim() || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.hooks.onCaptureError(`distil-large-v3 음성 인식에 실패했습니다. ${message}`);
      return null;
    } finally {
      await rm(outputPath, { force: true }).catch(() => undefined);
      if (audioPath !== originalAudioPath) {
        await rm(audioPath, { force: true }).catch(() => undefined);
      }
      await rm(originalAudioPath, { force: true }).catch(() => undefined);
    }
  }
}
