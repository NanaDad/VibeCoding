import { execFile, spawn } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createCaptureSnapshot } from '../shared/capture-backends.js';
import { createDebugLogger, type DebugLogger } from '../shared/debug-log.js';
import {
  applyLiveCaptureReadySnapshot,
  LiveAudioSttProvider,
  StreamingWhisperSttProvider,
  verifyLiveCaptureToolchain
} from './live-capture.js';
import type {
  CaptureSnapshot,
  ModeDescriptor,
  ProviderSummary,
  ReplySuggestion,
  RuntimeMode,
  TranscriptLine,
  TranslationProviderId,
  TranslationProviderStatus,
  TranslationRouteStatus,
  WorkerSnapshot
} from '../shared/runtime-contract.js';

interface RuntimeStartCommand {
  type: 'start';
  mode?: RuntimeMode;
  provider?: TranslationProviderId;
  logDirectory?: string;
  debugLogDirectory?: string;
}

interface RuntimeStopCommand {
  type: 'stop';
}

interface RuntimeRendererAudioChunkCommand {
  type: 'renderer-audio-chunk';
  data: number[];
  mimeType: string;
}

export type RuntimeCommand = RuntimeStartCommand | RuntimeStopCommand | RuntimeRendererAudioChunkCommand;

interface TranscriptChunk {
  id: string;
  text: string;
  finalized: boolean;
}

interface TranslationChunk {
  text: string;
  finalized: boolean;
}

interface SttProvider {
  readonly key: string;
  start(onChunk: (chunk: TranscriptChunk) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  ingestExternalChunk?(data: Uint8Array, mimeType: string): Promise<void>;
}

interface TranslationProvider {
  readonly id: TranslationProviderId;
  readonly key: string;
  readonly label: string;
  translate(chunk: TranscriptChunk): Promise<TranslationChunk>;
}

interface RuntimeModeConfig {
  providerSummary: ProviderSummary;
  modeDescriptor: ModeDescriptor;
  translationDelayMs: number;
  translatorKind: 'local' | 'remote';
}

interface RuntimeEvents {
  onSnapshot: (snapshot: WorkerSnapshot) => void;
}

interface RuntimeLogEntry {
  type:
    | 'session.started'
    | 'session.stopped'
    | 'capture.status'
    | 'transcript.chunk'
    | 'translation.chunk'
    | 'runtime.retry';
  timestamp: string;
  payload: Record<string, unknown>;
}

interface ChatGptApiCredentials {
  apiKey: string;
  source: 'env.CHATGPT_API_KEY' | 'env.OPENAI_API_KEY';
}

interface GeminiApiCredentials {
  apiKey: string;
  source: 'env.GEMINI_API_KEY';
}

interface DeepLCredentials {
  apiKey: string;
  source: 'env.DEEPL_API_KEY';
}

interface CodexCliCredentials {
  source: 'codex.chatgpt-auth';
  command: string;
  codexHome: string;
}

interface ResponsesApiOutputItem {
  type?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface ResponsesApiResponse {
  output_text?: string;
  output?: ResponsesApiOutputItem[];
  error?: {
    message?: string;
  };
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  error?: {
    message?: string;
  };
}

interface DeepLApiResponse {
  translations?: Array<{
    text?: string;
  }>;
  message?: string;
}

interface ResolvedTranslationRoute {
  providerSummary: string;
  routeLabel: string;
  healthMessage: string;
  translationProvider: TranslationProvider;
  translationRoute: TranslationRouteStatus;
}

export interface TranslationProbeResult {
  provider: TranslationProviderId;
  providerLabel: string;
  providerKey: string | null;
  success: boolean;
  translatedText: string | null;
  finalized: boolean;
  error: string | null;
}

const TRANSCRIPT_FIXTURES = [
  '音声ループバックの準備を始めます。',
  '軽量な字幕向けの翻訳を優先します。',
  '設定画面から翻訳 제공자를 고를 수 있습니다。',
  '通信이 불안정하면 DeepL fallback을 다시 시도합니다。',
  '実時間に近い表示を安定して続けます。'
];

const TRANSLATION_FIXTURES = new Map<string, string>([
  ['音声ループバックの準備を始めます。', '오디오 루프백 준비를 시작합니다.'],
  ['軽量な字幕向けの翻訳を優先します。', '가벼운 자막용 번역을 우선합니다.'],
  ['設定画面から翻訳 제공자를 고를 수 있습니다。', '설정 화면에서 번역 제공자를 고를 수 있습니다.'],
  ['通信이 불안정하면 DeepL fallback을 다시 시도합니다。', '통신이 불안정하면 DeepL fallback을 다시 시도합니다.'],
  ['実時間に近い表示を安定して続けます。', '실시간에 가까운 표시를 안정적으로 이어갑니다.']
]);

const PROVIDER_LABELS: Record<TranslationProviderId, string> = {
  auto: '자동 선택',
  'chatgpt-api': 'GPT API',
  'gemini-api': 'Gemini',
  'deepl-fallback': 'DeepL',
  'codex-auth': 'Codex auth',
  'local-fixture': '기본 확인'
};

const MODE_CONFIG: Record<RuntimeMode, RuntimeModeConfig> = {
  local: {
    providerSummary: {
      stt: 'live-capture.ffmpeg+whisper',
      translation: 'local.fixture-ja-ko'
    },
    modeDescriptor: {
      label: '기본 확인',
      description: '실오디오 입력을 로컬 캡처와 로컬 전사로 받아 빠르게 확인하는 모드입니다.',
      localFirst: true,
      cloudEnabled: false,
      requiresCredentials: false
    },
    translationDelayMs: 160,
    translatorKind: 'local'
  },
  hybrid: {
    providerSummary: {
      stt: 'live-capture.ffmpeg+whisper',
      translation: 'remote.selected-provider-ja-ko'
    },
    modeDescriptor: {
      label: '권장 모드',
      description: '실오디오 입력을 받아 로컬 전사 후, 번역은 설정에서 고른 provider로 진행합니다.',
      localFirst: true,
      cloudEnabled: true,
      requiresCredentials: true
    },
    translationDelayMs: 110,
    translatorKind: 'remote'
  },
  cloud: {
    providerSummary: {
      stt: 'live-capture.ffmpeg+whisper',
      translation: 'remote.selected-provider-ja-ko'
    },
    modeDescriptor: {
      label: '원격 번역 모드',
      description: '실오디오 입력을 받아 로컬 전사 후, 선택한 provider와 DeepL 대체 경로를 검증하는 원격 번역 모드입니다.',
      localFirst: false,
      cloudEnabled: true,
      requiresCredentials: true
    },
    translationDelayMs: 70,
    translatorKind: 'remote'
  }
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(rawValue: string | undefined, fallback: string) {
  if (!rawValue?.trim()) {
    return fallback;
  }
  return rawValue.replace(/\/+$/, '');
}

function getChatGptModel() {
  return process.env.CHATGPT_TRANSLATION_MODEL?.trim()
    || process.env.OPENAI_TRANSLATION_MODEL?.trim()
    || process.env.OPENAI_MODEL?.trim()
    || 'gpt-4.1-mini';
}

function getGeminiModel() {
  return process.env.GEMINI_TRANSLATION_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
}

function getDeepLModel() {
  return 'deepl-api';
}

function getCodexCliModel() {
  return process.env.CODEX_TRANSLATION_MODEL?.trim() || process.env.CODEX_MODEL?.trim() || null;
}

function getTranslatorContextPrompt() {
  const context = process.env.TRANSLATOR_USER_CONTEXT?.trim();
  const glossary = process.env.TRANSLATOR_GLOSSARY?.trim();
  const parts = [];
  if (context) {
    parts.push(`User context: ${context}`);
  }
  if (glossary) {
    parts.push(`Glossary and preferred terms: ${glossary}`);
  }
  return parts.length > 0
    ? `Use this private context to disambiguate technical terms, devices, roles, and domain vocabulary.\n${parts.join('\n')}`
    : '';
}

function buildReplySuggestions(_sourceText: string, translatedText: string): ReplySuggestion[] {
  const topicHint = translatedText.trim() ? `방금 말한 내용(${translatedText.trim()}) 기준으로` : '방금 말한 내용 기준으로';
  return [
    {
      id: 'acknowledge',
      korean: `${topicHint} 이해했습니다. 바로 확인해보겠습니다.`,
      japanese: '今の内容は理解しました。すぐ確認します。',
      reading: '이마노 나이요오와 리카이 시마시타. 스구 카쿠닌 시마스.'
    },
    {
      id: 'clarify',
      korean: '한 가지 더 확인하고 싶은데, 구체적인 조건을 다시 말해주실 수 있을까요?',
      japanese: '一つ確認したいのですが、具体的な条件をもう一度教えていただけますか。',
      reading: '히토츠 카쿠닌 시타이노데스가, 구타이테키나 조오켄오 모오 이치도 오시에테 이타다케마스카.'
    },
    {
      id: 'next-step',
      korean: '그 방향으로 진행하겠습니다. 결과가 나오면 바로 공유드리겠습니다.',
      japanese: 'その方向で進めます。結果が出たらすぐ共有します。',
      reading: '소노 호오코오데 스스메마스. 켓카가 데타라 스구 쿄오유우 시마스.'
    }
  ];
}

function getRemoteTimeoutMs() {
  const raw =
    Number.parseInt(process.env.TRANSLATION_TIMEOUT_MS ?? '', 10)
    || Number.parseInt(process.env.OPENAI_TRANSLATION_TIMEOUT_MS ?? '', 10)
    || Number.parseInt(process.env.GEMINI_TRANSLATION_TIMEOUT_MS ?? '', 10)
    || Number.parseInt(process.env.DEEPL_TRANSLATION_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 15_000;
  }
  return raw;
}

const execFileAsync = promisify(execFile);

function execFileWithStdin(command: string, args: string[], input: string, options: {
  timeout: number;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      windowsHide: options.windowsHide,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${options.timeout}ms.`));
    }, options.timeout);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command exited with ${signal ?? code}.`));
    });
    child.stdin.end(input);
  });
}

async function resolveCodexCliPath() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(os.homedir(), '.codex', 'bin', 'codex.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe')
      ]
    : [];

  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = await execFileAsync(command, ['codex'], {
    timeout: 5_000,
    windowsHide: true
  }).catch(() => null);

  candidates.push(...(result?.stdout
    ?.split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean) ?? []));

  const uniqueCandidates = [...new Set(candidates)];
  const runnableCandidates = uniqueCandidates
    .filter((candidate) => process.platform !== 'win32' || path.extname(candidate).toLowerCase() === '.exe')
    .sort((left, right) => {
      const leftWindowsApps = process.platform === 'win32' && left.includes(`${path.sep}WindowsApps${path.sep}`);
      const rightWindowsApps = process.platform === 'win32' && right.includes(`${path.sep}WindowsApps${path.sep}`);
      return Number(leftWindowsApps) - Number(rightWindowsApps);
    });

  const tryRunCodexVersion = async (candidate: string) => {
    try {
      await execFileAsync(candidate, ['--version'], {
        timeout: 5_000,
        windowsHide: true,
        env: {
          ...process.env,
          NO_COLOR: '1'
        }
      });
      return candidate;
    } catch {
      return null;
    }
  };

  for (const candidate of runnableCandidates) {
    const runnable = await tryRunCodexVersion(candidate);
    if (runnable) {
      return runnable;
    }

    if (process.platform === 'win32' && candidate.includes(`${path.sep}WindowsApps${path.sep}`)) {
      const copiedPath = path.join(os.homedir(), '.codex', 'bin', 'codex.exe');
      try {
        await mkdir(path.dirname(copiedPath), { recursive: true });
        await copyFile(candidate, copiedPath);
        const copiedRunnable = await tryRunCodexVersion(copiedPath);
        if (copiedRunnable) {
          return copiedRunnable;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function loadCodexCliCredentials(): Promise<CodexCliCredentials | null> {
  const authPath = process.env.CODEX_AUTH_PATH?.trim() || path.join(os.homedir(), '.codex', 'auth.json');
  try {
    const raw = await readFile(authPath, 'utf8');
    const parsed = JSON.parse(raw) as { auth_mode?: string; tokens?: { access_token?: string } };
    if (parsed.auth_mode !== 'chatgpt' || !parsed.tokens?.access_token?.trim()) {
      return null;
    }
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
      return null;
    }
    return {
      source: 'codex.chatgpt-auth',
      command: codexPath,
      codexHome: path.dirname(authPath)
    };
  } catch {
    return null;
  }
}

function loadChatGptApiCredentials(): ChatGptApiCredentials | null {
  const direct = process.env.CHATGPT_API_KEY?.trim();
  if (direct) {
    return {
      apiKey: direct,
      source: 'env.CHATGPT_API_KEY'
    };
  }

  const openai = process.env.OPENAI_API_KEY?.trim();
  if (openai) {
    return {
      apiKey: openai,
      source: 'env.OPENAI_API_KEY'
    };
  }

  return null;
}

function loadGeminiApiCredentials(): GeminiApiCredentials | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return apiKey ? { apiKey, source: 'env.GEMINI_API_KEY' } : null;
}

function loadDeepLCredentials(): DeepLCredentials | null {
  const apiKey = process.env.DEEPL_API_KEY?.trim();
  return apiKey ? { apiKey, source: 'env.DEEPL_API_KEY' } : null;
}

async function detectProviderStatuses(selected: TranslationProviderId): Promise<TranslationProviderStatus[]> {
  const chatGpt = loadChatGptApiCredentials();
  const gemini = loadGeminiApiCredentials();
  const deepl = loadDeepLCredentials();
  const codex = await loadCodexCliCredentials();
  const autoReadyProvider = chatGpt ? 'chatgpt-api' : gemini ? 'gemini-api' : deepl ? 'deepl-fallback' : codex ? 'codex-auth' : null;

  const statuses: TranslationProviderStatus[] = [
    {
      id: 'auto',
      label: PROVIDER_LABELS.auto,
      configured: Boolean(autoReadyProvider),
      available: Boolean(autoReadyProvider),
      state: selected === 'auto' ? (autoReadyProvider ? 'active' : 'missing-config') : (autoReadyProvider ? 'ready' : 'missing-config'),
      detail: autoReadyProvider
        ? `${PROVIDER_LABELS[autoReadyProvider]}가 자동 기본값으로 선택됩니다.`
        : 'GPT API, Gemini, DeepL 중 하나를 저장하면 자동 선택이 바로 활성화됩니다.'
    },
    {
      id: 'chatgpt-api',
      label: PROVIDER_LABELS['chatgpt-api'],
      configured: Boolean(chatGpt),
      available: Boolean(chatGpt),
      state: selected === 'chatgpt-api'
        ? (chatGpt ? 'active' : 'missing-config')
        : (chatGpt ? 'ready' : 'missing-config'),
      detail: chatGpt
        ? `${chatGpt.source} 기준으로 설정이 확인되었습니다.`
        : '앱 설정에서 GPT API 키를 입력하세요.'
    },
    {
      id: 'gemini-api',
      label: PROVIDER_LABELS['gemini-api'],
      configured: Boolean(gemini),
      available: Boolean(gemini),
      state: selected === 'gemini-api'
        ? (gemini ? 'active' : 'missing-config')
        : (gemini ? 'ready' : 'missing-config'),
      detail: gemini
        ? 'Gemini API 키가 확인되었습니다.'
        : '앱 설정에서 Gemini API 키를 입력하세요.'
    },
    {
      id: 'deepl-fallback',
      label: PROVIDER_LABELS['deepl-fallback'],
      configured: Boolean(deepl),
      available: Boolean(deepl),
      state: selected === 'deepl-fallback'
        ? (deepl ? 'active' : 'missing-config')
        : (deepl ? 'ready' : 'missing-config'),
      detail: deepl
        ? 'DeepL 키가 확인되어 선택 경로 또는 대체 경로로 사용할 수 있습니다.'
        : '앱 설정에서 DeepL API 키를 입력하세요.'
    },
    {
      id: 'codex-auth',
      label: PROVIDER_LABELS['codex-auth'],
      configured: Boolean(codex),
      available: Boolean(codex),
      state: selected === 'codex-auth'
        ? (codex ? 'active' : 'manual-auth')
        : (codex ? 'ready' : 'manual-auth'),
      detail: codex
        ? '고급 옵션이 준비되었습니다. Codex CLI 로그인 상태가 확인되어 별도 API 키 없이 사용할 수 있습니다.'
        : '고급 옵션입니다. 이 경로를 쓰려면 Codex CLI 설치와 ChatGPT 로그인이 둘 다 필요합니다.'
    },
    {
      id: 'local-fixture',
      label: PROVIDER_LABELS['local-fixture'],
      configured: true,
      available: true,
      state: selected === 'local-fixture' ? 'active' : 'ready',
      detail: '실오디오/STT 흐름을 점검하는 내장 확인 경로입니다. 실사용 번역은 GPT API, Gemini, DeepL, Codex auth 중 하나를 설정해야 합니다.'
    }
  ];

  return statuses;
}

function setRouteState(
  statuses: TranslationProviderStatus[],
  providerId: TranslationProviderId,
  state: TranslationProviderStatus['state'],
  detail?: string
) {
  return statuses.map((status) => (
    status.id === providerId
      ? {
          ...status,
          state,
          detail: detail ?? status.detail
        }
      : status
  ));
}

function extractResponseText(payload: ResponsesApiResponse) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const contentTexts = payload.output
    ?.flatMap((item) => item.content ?? [])
    .map((item) => item.text?.trim())
    .filter((value): value is string => Boolean(value));

  if (contentTexts?.length) {
    return contentTexts.join('\n').trim();
  }

  return null;
}

function extractGeminiResponseText(payload: GeminiApiResponse) {
  const text = payload.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .trim();

  return text || null;
}

class FixtureSttProvider implements SttProvider {
  readonly key: string;
  private timer: NodeJS.Timeout | null = null;
  private cancelled = false;
  private fixtureIndex = 0;

  constructor(key: string) {
    this.key = key;
  }

  async start(onChunk: (chunk: TranscriptChunk) => Promise<void>) {
    this.cancelled = false;
    this.fixtureIndex = 0;

    const emitNext = async () => {
      if (this.cancelled) {
        return;
      }

      const text = TRANSCRIPT_FIXTURES[this.fixtureIndex % TRANSCRIPT_FIXTURES.length];
      const chunk: TranscriptChunk = {
        id: `chunk-${Date.now()}-${this.fixtureIndex}`,
        text,
        finalized: true
      };

      this.fixtureIndex += 1;
      await onChunk(chunk);
      this.timer = setTimeout(() => {
        void emitNext();
      }, 900);
    };

    this.timer = setTimeout(() => {
      void emitNext();
    }, 260);
  }

  async stop() {
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

class FixtureTranslationProvider implements TranslationProvider {
  readonly id: TranslationProviderId = 'local-fixture';
  readonly key: string;
  readonly label = PROVIDER_LABELS['local-fixture'];
  private readonly delayMs: number;

  constructor(key: string, delayMs: number) {
    this.key = key;
    this.delayMs = delayMs;
  }

  async translate(chunk: TranscriptChunk) {
    await wait(this.delayMs);
    return {
      text: TRANSLATION_FIXTURES.get(chunk.text) ?? `확인용 출력: ${chunk.text}`, 
      finalized: chunk.finalized
    };
  }
}

class ChatGptApiTranslationProvider implements TranslationProvider {
  readonly id: TranslationProviderId = 'chatgpt-api';
  readonly key: string;
  readonly label = PROVIDER_LABELS['chatgpt-api'];
  readonly credentialSource: ChatGptApiCredentials['source'];
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(credentials: ChatGptApiCredentials) {
    this.key = `chatgpt-api.${credentials.source}`;
    this.apiKey = credentials.apiKey;
    this.credentialSource = credentials.source;
    this.model = getChatGptModel();
    this.baseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
    this.timeoutMs = getRemoteTimeoutMs();
  }

  async translate(chunk: TranscriptChunk) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const contextPrompt = getTranslatorContextPrompt();

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          input: [
            {
              role: 'system',
              content:
                [
                  'Translate Japanese speech transcripts into natural Korean subtitle lines. Keep it concise. Output Korean only.',
                  contextPrompt
                ].filter(Boolean).join('\n\n')
            },
            {
              role: 'user',
              content: chunk.text
            }
          ],
          text: {
            format: {
              type: 'text'
            }
          }
        })
      });

      const payload = (await response.json().catch(() => ({}))) as ResponsesApiResponse;
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(`ChatGPT API authentication failed (HTTP 401). Credential source: ${this.credentialSource}.`);
        }
        if (response.status === 429) {
          throw new Error('ChatGPT API rate-limited the request (HTTP 429).');
        }
        throw new Error(payload.error?.message?.trim() || `ChatGPT API request failed with HTTP ${response.status}.`);
      }

      const translatedText = extractResponseText(payload);
      if (!translatedText) {
        throw new Error('ChatGPT API returned no usable text.');
      }

      return {
        text: translatedText,
        finalized: chunk.finalized
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`ChatGPT API timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof TypeError) {
        throw new Error('ChatGPT API network request failed. Check internet access or OPENAI_BASE_URL.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class GeminiApiTranslationProvider implements TranslationProvider {
  readonly id: TranslationProviderId = 'gemini-api';
  readonly key: string;
  readonly label = PROVIDER_LABELS['gemini-api'];
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(credentials: GeminiApiCredentials) {
    this.key = `gemini-api.${credentials.source}`;
    this.apiKey = credentials.apiKey;
    this.model = getGeminiModel();
    this.baseUrl = normalizeBaseUrl(
      process.env.GEMINI_BASE_URL,
      'https://generativelanguage.googleapis.com/v1beta'
    );
    this.timeoutMs = getRemoteTimeoutMs();
  }

  async translate(chunk: TranscriptChunk) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const contextPrompt = getTranslatorContextPrompt();

    try {
      const response = await fetch(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: [
                    'Translate Japanese speech transcripts into natural Korean subtitle lines. Keep it concise. Output Korean only.',
                    contextPrompt
                  ].filter(Boolean).join('\n\n')
                }
              ]
            },
            contents: [
              {
                parts: [
                  {
                    text: chunk.text
                  }
                ]
              }
            ]
          })
        }
      );

      const payload = (await response.json().catch(() => ({}))) as GeminiApiResponse;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Gemini API authentication failed.');
        }
        if (response.status === 429) {
          throw new Error('Gemini API rate-limited the request (HTTP 429).');
        }
        throw new Error(payload.error?.message?.trim() || `Gemini API request failed with HTTP ${response.status}.`);
      }

      const translatedText = extractGeminiResponseText(payload);
      if (!translatedText) {
        throw new Error('Gemini API returned no usable text.');
      }

      return {
        text: translatedText,
        finalized: chunk.finalized
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Gemini API timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof TypeError) {
        throw new Error('Gemini API network request failed. Check internet access or GEMINI_BASE_URL.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class DeepLTranslationProvider implements TranslationProvider {
  readonly id: TranslationProviderId = 'deepl-fallback';
  readonly key: string;
  readonly label = PROVIDER_LABELS['deepl-fallback'];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(credentials: DeepLCredentials) {
    this.key = `deepl-fallback.${credentials.source}`;
    this.apiKey = credentials.apiKey;
    this.baseUrl = normalizeBaseUrl(process.env.DEEPL_BASE_URL, 'https://api-free.deepl.com');
    this.timeoutMs = getRemoteTimeoutMs();
  }

  async translate(chunk: TranscriptChunk) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v2/translate`, {
        method: 'POST',
        headers: {
          authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        signal: controller.signal,
        body: new URLSearchParams({
          text: chunk.text,
          source_lang: 'JA',
          target_lang: 'KO'
        }).toString()
      });

      const payload = (await response.json().catch(() => ({}))) as DeepLApiResponse;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('DeepL authentication failed.');
        }
        if (response.status === 429) {
          throw new Error('DeepL rate-limited the request (HTTP 429).');
        }
        throw new Error(payload.message?.trim() || `DeepL request failed with HTTP ${response.status}.`);
      }

      const translatedText = payload.translations?.[0]?.text?.trim();
      if (!translatedText) {
        throw new Error('DeepL returned no usable text.');
      }

      return {
        text: translatedText,
        finalized: chunk.finalized
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`DeepL timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof TypeError) {
        throw new Error('DeepL network request failed. Check internet access or DEEPL_BASE_URL.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class CodexCliTranslationProvider implements TranslationProvider {
  readonly id: TranslationProviderId = 'codex-auth';
  readonly key: string;
  readonly label = PROVIDER_LABELS['codex-auth'];
  private readonly command: string;
  private readonly codexHome: string;
  private readonly timeoutMs: number;
  private readonly model: string | null;

  constructor(credentials: CodexCliCredentials) {
    this.key = `codex-auth.${credentials.source}`;
    this.command = credentials.command;
    this.codexHome = credentials.codexHome;
    this.timeoutMs = Math.max(getRemoteTimeoutMs(), 30_000);
    this.model = getCodexCliModel();
  }

  async translate(chunk: TranscriptChunk) {
    const contextPrompt = getTranslatorContextPrompt();
    const prompt = [
      'Translate this Japanese speech transcript into natural Korean subtitle style.',
      'Keep it concise.',
      'Output Korean only.',
      contextPrompt,
      '',
      chunk.text
    ].filter(Boolean).join('\n');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'jp-ko-codex-translation-'));
    const outputPath = path.join(tempDir, 'last-message.txt');

    try {
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--output-last-message',
        outputPath,
        '-'
      ];
      if (this.model) {
        args.push('--model', this.model);
      }

      await execFileWithStdin(this.command, args, prompt, {
        timeout: this.timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          CODEX_HOME: this.codexHome,
          NO_COLOR: '1'
        }
      });

      const translatedText = (await readFile(outputPath, 'utf8')).trim();
      if (!translatedText) {
        throw new Error('Codex auth translation returned no usable text.');
      }

      return {
        text: translatedText,
        finalized: chunk.finalized
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('timed out')) {
        throw new Error(`Codex auth translation timed out after ${this.timeoutMs}ms.`);
      }
      throw new Error(`Codex auth translation failed. ${message}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

class FallbackTranslationProvider implements TranslationProvider {
  readonly key: string;
  readonly label: string;
  readonly id: TranslationProviderId;
  private readonly primary: TranslationProvider;
  private readonly fallback: TranslationProvider | null;
  private readonly onFallback: (detail: string) => void;

  constructor(primary: TranslationProvider, fallback: TranslationProvider | null, onFallback: (detail: string) => void) {
    this.primary = primary;
    this.fallback = fallback;
    this.onFallback = onFallback;
    this.id = primary.id;
    this.label = primary.label;
    this.key = fallback ? `${primary.key}->${fallback.key}` : primary.key;
  }

  async translate(chunk: TranscriptChunk) {
    try {
      return await this.primary.translate(chunk);
    } catch (error) {
      if (!this.fallback) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.onFallback(message);
      return this.fallback.translate(chunk);
    }
  }
}

async function resolveAutoProviderId(): Promise<Exclude<TranslationProviderId, 'auto'>> {
  if (loadChatGptApiCredentials()) return 'chatgpt-api';
  if (loadGeminiApiCredentials()) return 'gemini-api';
  if (loadDeepLCredentials()) return 'deepl-fallback';
  if (await loadCodexCliCredentials()) return 'codex-auth';
  throw new Error('자동 선택에 사용할 provider가 없습니다. GPT API, Gemini, DeepL 중 하나를 먼저 저장하세요.');
}

async function createSelectedProvider(provider: TranslationProviderId): Promise<TranslationProvider> {
  switch (provider) {
    case 'auto':
      return createSelectedProvider(await resolveAutoProviderId());
    case 'local-fixture':
      return new FixtureTranslationProvider('local.fixture-ja-ko', MODE_CONFIG.local.translationDelayMs);
    case 'codex-auth': {
      const credentials = await loadCodexCliCredentials();
      if (!credentials) {
        throw new Error('Codex auth is not ready. Sign in through Codex CLI first.');
      }
      return new CodexCliTranslationProvider(credentials);
    }
    case 'chatgpt-api': {
      const credentials = loadChatGptApiCredentials();
      if (!credentials) {
        throw new Error('ChatGPT API가 설정되지 않았습니다. CHATGPT_API_KEY 또는 OPENAI_API_KEY를 설정하세요.');
      }
      return new ChatGptApiTranslationProvider(credentials);
    }
    case 'gemini-api': {
      const credentials = loadGeminiApiCredentials();
      if (!credentials) {
        throw new Error('Gemini API가 설정되지 않았습니다. GEMINI_API_KEY를 설정하세요.');
      }
      return new GeminiApiTranslationProvider(credentials);
    }
    case 'deepl-fallback': {
      const credentials = loadDeepLCredentials();
      if (!credentials) {
        throw new Error('DeepL이 설정되지 않았습니다. DEEPL_API_KEY를 설정하세요.');
      }
      return new DeepLTranslationProvider(credentials);
    }
  }
}

export async function runTranslationProbe(
  provider: TranslationProviderId,
  text: string
): Promise<TranslationProbeResult> {
  try {
    const translationProvider = await createSelectedProvider(provider);
    const translated = await translationProvider.translate({
      id: `probe-${Date.now()}`,
      text,
      finalized: true
    });
    return {
      provider,
      providerLabel: PROVIDER_LABELS[provider],
      providerKey: translationProvider.key,
      success: true,
      translatedText: translated.text,
      finalized: translated.finalized,
      error: null
    };
  } catch (error) {
    return {
      provider,
      providerLabel: PROVIDER_LABELS[provider],
      providerKey: null,
      success: false,
      translatedText: null,
      finalized: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function createProviders(
  mode: RuntimeMode,
  selectedProvider: TranslationProviderId,
  capture: CaptureSnapshot,
  onCaptureEvent: {
    ready: (detail: { deviceLabel: string; backendLabel: string; command: string }) => Promise<void>;
    error: (message: string) => Promise<void>;
    exit: (message: string) => Promise<void>;
  },
  onFallback: (detail: string) => void
): Promise<{ sttProvider: SttProvider; route: ResolvedTranslationRoute }> {
  const config = MODE_CONFIG[mode];
  const sttProvider = await createSttProvider(capture, onCaptureEvent);
  const providerStatuses = await detectProviderStatuses(selectedProvider);

  if (config.translatorKind === 'local' || selectedProvider === 'local-fixture') {
    const translationProvider = new FixtureTranslationProvider(config.providerSummary.translation, config.translationDelayMs);
    return {
      sttProvider,
      route: {
        providerSummary: translationProvider.key,
        routeLabel: '실오디오 입력 + 기본 확인',
        healthMessage: '실오디오 입력과 로컬 전사가 활성화되어 있으며, 번역은 기본 내장 경로로 처리합니다.',
        translationProvider,
        translationRoute: {
          selected: 'local-fixture',
          active: 'local-fixture',
          fallbackUsed: false,
          selectedLabel: PROVIDER_LABELS['local-fixture'],
          activeLabel: PROVIDER_LABELS['local-fixture'],
          detail: '기본 내장 번역이 선택된 상태입니다.',
          providerStatuses: setRouteState(providerStatuses, 'local-fixture', 'active')
        }
      }
    };
  }

  const resolvedSelectedProvider = selectedProvider === 'auto' ? await resolveAutoProviderId() : selectedProvider;
  let selected = await createSelectedProvider(resolvedSelectedProvider);
  let activeProvider = selected;
  let fallbackUsed = false;
  let routeDetail = selectedProvider === 'auto'
    ? `${PROVIDER_LABELS[resolvedSelectedProvider]}가 자동 기본값으로 선택되었습니다.`
    : `${PROVIDER_LABELS[selectedProvider]} 경로가 선택되었습니다.`;
  let providerStatusesNext = setRouteState(providerStatuses, selectedProvider, 'active');
  if (selectedProvider === 'auto') {
    providerStatusesNext = setRouteState(providerStatusesNext, resolvedSelectedProvider, 'active', `${PROVIDER_LABELS[resolvedSelectedProvider]}가 자동 기본값으로 선택되었습니다.`);
  } else {
    providerStatusesNext = setRouteState(providerStatusesNext, resolvedSelectedProvider, 'active');
  }

  const fallbackCandidate =
    resolvedSelectedProvider === 'deepl-fallback'
      ? null
      : await createSelectedProvider('deepl-fallback').catch(() => null);

  if (fallbackCandidate) {
    selected = new FallbackTranslationProvider(selected, fallbackCandidate, (detail) => {
      fallbackUsed = true;
      activeProvider = fallbackCandidate;
      routeDetail = `${PROVIDER_LABELS[resolvedSelectedProvider]}가 실패하여 DeepL 대체 경로로 전환되었습니다.`;
      providerStatusesNext = setRouteState(providerStatusesNext, selectedProvider, 'ready', detail);
      providerStatusesNext = setRouteState(providerStatusesNext, resolvedSelectedProvider, 'ready', detail);
      providerStatusesNext = setRouteState(providerStatusesNext, 'deepl-fallback', 'fallback-active', '현재 DeepL 대체 경로가 번역을 처리하고 있습니다.');
      onFallback(detail);
    });
  }

  return {
    sttProvider,
    route: {
      providerSummary: selected.key,
      routeLabel: `실오디오 입력 + ${PROVIDER_LABELS[resolvedSelectedProvider]} 번역`,
      healthMessage:
        fallbackCandidate
          ? `실오디오 입력과 ${PROVIDER_LABELS[resolvedSelectedProvider]} 번역 경로가 활성화되어 있으며, 실패 시 DeepL 대체 경로가 자동으로 이어받습니다.`
          : `실오디오 입력과 ${PROVIDER_LABELS[resolvedSelectedProvider]} 번역 경로가 활성화되어 있으며, 현재 대체 경로는 설정되어 있지 않습니다.`,
      translationProvider: selected,
      translationRoute: {
        selected: selectedProvider,
        active: activeProvider.id,
        fallbackUsed,
        selectedLabel: PROVIDER_LABELS[selectedProvider],
        activeLabel: activeProvider.label,
        detail: routeDetail,
        providerStatuses: providerStatusesNext
      }
    }
  };
}

async function createSttProvider(
  capture: CaptureSnapshot,
  onCaptureEvent: {
    ready: (detail: { deviceLabel: string; backendLabel: string; command: string }) => Promise<void>;
    error: (message: string) => Promise<void>;
    exit: (message: string) => Promise<void>;
  }
) {
  if (process.env.TRANSLATOR_FORCE_FIXTURE === '1') {
    return new FixtureSttProvider('fixture.transcript-feed');
  }

  if (process.env.TRANSLATOR_STT_BACKEND === 'whisper-stream') {
    return new StreamingWhisperSttProvider(capture.platform, {
      onCaptureReady: onCaptureEvent.ready,
      onCaptureError: onCaptureEvent.error,
      onCaptureExit: onCaptureEvent.exit
    });
  }

  if (process.env.TRANSLATOR_CAPTURE_BACKEND === 'renderer-audio') {
    await verifyLiveCaptureToolchain(capture.platform);
    return new LiveAudioSttProvider(capture.platform, {
      onCaptureReady: onCaptureEvent.ready,
      onCaptureError: onCaptureEvent.error,
      onCaptureExit: onCaptureEvent.exit
    }, { externalInput: true });
  }

  if (capture.platform !== 'win32' && capture.platform !== 'darwin') {
    return new FixtureSttProvider('fixture.transcript-feed');
  }

  await verifyLiveCaptureToolchain(capture.platform);
  return new LiveAudioSttProvider(capture.platform, {
    onCaptureReady: onCaptureEvent.ready,
    onCaptureError: onCaptureEvent.error,
    onCaptureExit: onCaptureEvent.exit
  });
}

export class TranslatorRuntime {
  private snapshot: WorkerSnapshot;
  private readonly events: RuntimeEvents;
  private sttProvider: SttProvider | null = null;
  private translationProvider: TranslationProvider | null = null;
  private logPath: string | null = null;
  private activeRunId = 0;
  private debugLogger: DebugLogger | null = null;

  constructor(events: RuntimeEvents) {
    this.events = events;
    this.snapshot = this.createSnapshot('local', 'local-fixture');
  }

  getSnapshot() {
    return this.snapshot;
  }

  async handleCommand(command: RuntimeCommand) {
    if (command.type === 'start') {
      await this.start(
        command.mode ?? 'local',
        command.provider ?? (command.mode === 'local' ? 'local-fixture' : 'chatgpt-api'),
        command.logDirectory ?? path.join(process.cwd(), 'logs'),
        command.debugLogDirectory ?? path.join(process.cwd(), 'logs')
      );
      return this.snapshot;
    }

    if (command.type === 'renderer-audio-chunk') {
      await this.ingestRendererAudioChunk(command.data, command.mimeType);
      return this.snapshot;
    }

    await this.debug('worker.command.stop', {
      phase: this.snapshot.phase,
      mode: this.snapshot.mode,
      retryCount: this.snapshot.retryCount
    });
    await this.stop();
    return this.snapshot;
  }

  private async ingestRendererAudioChunk(data: number[], mimeType: string) {
    if (!this.sttProvider?.ingestExternalChunk) {
      await this.debug('worker.renderer-audio.skip', {
        reason: 'provider-does-not-accept-external-audio',
        phase: this.snapshot.phase
      });
      return;
    }
    await this.sttProvider.ingestExternalChunk(Uint8Array.from(data), mimeType);
  }

  async reportHostIssue(event: string, error?: unknown) {
    await this.debug(event, {
      phase: this.snapshot.phase,
      mode: this.snapshot.mode,
      retryCount: this.snapshot.retryCount,
      error: error instanceof Error ? error : error ? { message: String(error) } : null
    });
  }

  private createSnapshot(mode: RuntimeMode, selectedProvider: TranslationProviderId): WorkerSnapshot {
    const config = MODE_CONFIG[mode];
    const capture = createCaptureSnapshot(process.platform);
    const liveCaptureCapable = capture.platform === 'win32' || capture.platform === 'darwin';
    return {
      phase: 'idle',
      mode,
      sourceLanguage: 'ja',
      targetLanguage: 'ko',
      transcriptSource: liveCaptureCapable ? 'live-capture' : 'fixture',
      transcriptSourceLabel: liveCaptureCapable ? '실시간 오디오 입력' : '데모 자막 입력',
      liveCaptureImplemented: liveCaptureCapable,
      providerSummary: config.providerSummary,
      translationRoute: {
        selected: selectedProvider,
        active: selectedProvider,
        fallbackUsed: false,
        selectedLabel: PROVIDER_LABELS[selectedProvider],
        activeLabel: PROVIDER_LABELS[selectedProvider],
        detail: `${PROVIDER_LABELS[selectedProvider]} 경로가 선택된 상태입니다.`,
        providerStatuses: []
      },
      modeDescriptor: config.modeDescriptor,
      capture,
      startedAt: null,
      lastError: null,
      retryCount: 0,
      healthMessage: '실행 대기 중입니다.',
      logPath: null,
      debugLogPath: null,
      logDirectory: null,
      logPathDetail: null,
      routeLabel:
        config.translatorKind === 'remote'
          ? `실오디오 입력 + ${PROVIDER_LABELS[selectedProvider]} 번역`
          : '실오디오 입력 + 기본 확인',
      lines: []
    };
  }

  private emitSnapshot() {
    this.events.onSnapshot(this.snapshot);
  }

  private async debug(event: string, payload: Record<string, unknown>) {
    if (!this.debugLogger) {
      return;
    }
    await this.debugLogger.log(event, payload);
  }

  private updateSnapshot(next: Partial<WorkerSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...next
    };
    this.emitSnapshot();
    void this.debug('worker.snapshot.update', {
      phase: this.snapshot.phase,
      mode: this.snapshot.mode,
      retryCount: this.snapshot.retryCount,
      capturePhase: this.snapshot.capture.phase,
      lineCount: this.snapshot.lines.length,
      lastError: this.snapshot.lastError,
      routeLabel: this.snapshot.routeLabel,
      activeProvider: this.snapshot.translationRoute.active
    });
  }

  private upsertLine(line: TranscriptLine) {
    const nextLines = [...this.snapshot.lines.filter((item) => item.id !== line.id), line].slice(-6);
    this.updateSnapshot({
      lines: nextLines
    });
  }

  private async writeLog(entry: RuntimeLogEntry) {
    if (!this.logPath) {
      return;
    }

    await mkdir(path.dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private async start(mode: RuntimeMode, selectedProvider: TranslationProviderId, logDirectory: string, debugLogDirectory: string) {
    await this.sttProvider?.stop();
    this.sttProvider = null;
    this.translationProvider = null;

    this.activeRunId += 1;
    const runId = this.activeRunId;
    const baseSnapshot = this.createSnapshot(mode, selectedProvider);
    const startedAt = new Date().toISOString();
    this.logPath = path.join(logDirectory, `session-${startedAt.replaceAll(':', '-')}.jsonl`);

    this.debugLogger = createDebugLogger({
      logDirectory: debugLogDirectory,
      scope: `worker-${runId}`
    });

    const unsupportedCapture = !baseSnapshot.capture.supportsSystemAudio;
    const manualCaptureSetup = baseSnapshot.capture.backendAvailability === 'manual-setup';

    await this.debug('worker.session.starting', {
      runId,
      mode,
      selectedProvider,
      logPath: this.logPath,
      debugLogPath: this.debugLogger.textPath,
      unsupportedCapture,
      translatorKind: MODE_CONFIG[mode].translatorKind
    });

    this.snapshot = {
      ...baseSnapshot,
      phase: 'starting',
      startedAt,
      logPath: this.logPath,
      debugLogPath: this.debugLogger.textPath,
      logDirectory,
      logPathDetail: `세션 로그: ${this.logPath} | 디버그 로그: ${this.debugLogger.textPath}`,
      healthMessage:
        MODE_CONFIG[mode].translatorKind === 'remote'
          ? '실오디오 캡처와 선택한 provider 준비 상태를 점검하는 중입니다.'
          : '실오디오 캡처와 로컬 번역 경로를 초기화하는 중입니다.'
    };
    this.emitSnapshot();

    await this.writeLog({
      type: 'session.started',
      timestamp: startedAt,
      payload: {
        mode,
        selectedProvider,
        providerSummary: this.snapshot.providerSummary,
        routeLabel: this.snapshot.routeLabel
      }
    });

    let routeDetailMessage = '';
    try {
      const providers = await createProviders(mode, selectedProvider, this.snapshot.capture, {
      ready: async (detail) => {
        this.updateSnapshot({
          transcriptSource: 'live-capture',
          transcriptSourceLabel: `실시간 오디오 입력 (${detail.deviceLabel})`,
          liveCaptureImplemented: true,
          capture: applyLiveCaptureReadySnapshot(this.snapshot.capture, {
            backend: process.platform === 'win32' ? 'windows-wasapi-loopback' : 'macos-screencapturekit-native',
            backendLabel: detail.backendLabel,
            deviceLabel: detail.deviceLabel
          }),
          healthMessage: `${detail.backendLabel}가 실제 입력선을 열었습니다.`,
          lastError: null
        });
        await this.debug('worker.capture.ready', {
          runId,
          deviceLabel: detail.deviceLabel,
          backendLabel: detail.backendLabel,
          command: detail.command
        });
      },
      error: async (message) => {
        this.updateSnapshot({
          capture: {
            ...this.snapshot.capture,
            phase: 'error',
            lastError: message,
            guidance: message
          },
          lastError: message,
          healthMessage: '실오디오 캡처 또는 전사 단계에서 오류가 발생했습니다.'
        });
        await this.debug('worker.capture.error', {
          runId,
          message
        });
      },
      exit: async (message) => {
        const enrichedMessage = this.snapshot.logPathDetail
          ? `${message} ${this.snapshot.logPathDetail}`
          : message;
        this.updateSnapshot({
          phase: 'error',
          capture: {
            ...this.snapshot.capture,
            phase: 'error',
            lastError: enrichedMessage,
            guidance: enrichedMessage
          },
          lastError: enrichedMessage,
          healthMessage: '실오디오 캡처 프로세스가 중단되었습니다.'
        });
        await this.debug('worker.capture.exit', {
          runId,
          message: enrichedMessage
        });
      }
      }, (detail) => {
      routeDetailMessage = detail;
      this.updateSnapshot({
        translationRoute: {
          ...this.snapshot.translationRoute,
          active: 'deepl-fallback',
          activeLabel: PROVIDER_LABELS['deepl-fallback'],
          fallbackUsed: true,
          detail: `${PROVIDER_LABELS[selectedProvider]}가 실패하여 DeepL 대체 경로로 전환되었습니다. ${detail}`
        },
        providerSummary: {
          ...this.snapshot.providerSummary,
          translation: `deepl-fallback.model=${getDeepLModel()}`
        },
        routeLabel: `실오디오 입력 + ${PROVIDER_LABELS['deepl-fallback']} 번역`,
        healthMessage: `${PROVIDER_LABELS[selectedProvider]}가 실패하여 DeepL 대체 경로가 활성화되었습니다.`
      });
      });
      this.sttProvider = providers.sttProvider;
      this.translationProvider = providers.route.translationProvider;

      this.updateSnapshot({
        phase: 'running',
        routeLabel: providers.route.routeLabel,
        transcriptSource: this.snapshot.capture.platform === 'win32' || this.snapshot.capture.platform === 'darwin'
          ? 'live-capture'
          : 'fixture',
        transcriptSourceLabel: this.snapshot.capture.platform === 'win32' || this.snapshot.capture.platform === 'darwin'
          ? '실시간 오디오 입력'
          : '데모 자막 입력',
        liveCaptureImplemented: this.snapshot.capture.platform === 'win32' || this.snapshot.capture.platform === 'darwin',
        providerSummary: {
          ...this.snapshot.providerSummary,
          stt: this.sttProvider.key,
          translation: providers.route.providerSummary
        },
        translationRoute: providers.route.translationRoute,
        capture: {
          ...this.snapshot.capture,
          phase: this.snapshot.capture.supportsSystemAudio ? 'probing' : 'unsupported',
          guidance: this.snapshot.capture.supportsSystemAudio
            ? manualCaptureSetup
              ? `${providers.route.routeLabel} 경로가 활성화되어 있습니다. ${this.snapshot.capture.backendLabel}는 실제 장치 입력을 받지만 시스템 오디오를 받으려면 수동 라우팅이 필요합니다. ${this.snapshot.capture.availableBackends[0]?.setupHint ?? ''}`.trim()
              : `${providers.route.routeLabel} 경로가 활성화되어 있습니다. ${this.snapshot.capture.backendLabel} 연결을 확인하는 중입니다. 첫 오디오 청크가 저장되면 실제 캡처 상태로 전환됩니다.`
            : `${providers.route.routeLabel} 경로가 활성화되어 있지만, 이 호스트에는 아직 지원되는 live system-audio 백엔드가 없습니다.`
        },
        healthMessage:
          providers.route.healthMessage
          || (unsupportedCapture
            ? '지원 범위 밖 호스트에서 데모 자막과 번역 이벤트를 provider 구조로 점검 중입니다.'
            : '실오디오 캡처와 전사 경로를 점검 중입니다. 첫 입력 청크를 기다리고 있습니다.')
      });

      await this.writeLog({
        type: 'capture.status',
        timestamp: new Date().toISOString(),
        payload: {
          phase: this.snapshot.capture.phase,
          backend: this.snapshot.capture.backend,
          deviceLabel: this.snapshot.capture.deviceLabel,
          routeLabel: this.snapshot.routeLabel,
          translationRoute: this.snapshot.translationRoute
        }
      });

      await this.sttProvider.start(async (chunk) => {
      if (runId !== this.activeRunId || !this.translationProvider) {
        return;
      }

      await this.debug('worker.transcript.received', {
        runId,
        chunkId: chunk.id,
        finalized: chunk.finalized,
        sourceLength: chunk.text.length
      });

      const createdAt = new Date().toISOString();
      const line: TranscriptLine = {
        id: chunk.id,
        sourceText: chunk.text,
        translatedText: '',
        replySuggestions: [],
        sourceFinal: chunk.finalized,
        translatedFinal: false,
        createdAt
      };
      this.upsertLine(line);

      await this.writeLog({
        type: 'transcript.chunk',
        timestamp: createdAt,
        payload: {
          provider: this.sttProvider?.key,
          sourceText: chunk.text
        }
      });

      try {
        const translated = await this.translationProvider.translate(chunk);
        if (runId !== this.activeRunId) {
          return;
        }

        this.upsertLine({
          ...line,
          translatedText: translated.text,
          replySuggestions: buildReplySuggestions(chunk.text, translated.text),
          translatedFinal: translated.finalized
        });

        this.updateSnapshot({
          translationRoute: routeDetailMessage
            ? {
                ...this.snapshot.translationRoute,
                active: 'deepl-fallback',
                activeLabel: PROVIDER_LABELS['deepl-fallback'],
                fallbackUsed: true,
                detail: `${PROVIDER_LABELS[selectedProvider]}가 실패하여 DeepL 대체 경로로 전환되었습니다. ${routeDetailMessage}`
              }
            : this.snapshot.translationRoute
        });

        await this.debug('worker.translation.completed', {
          runId,
          chunkId: chunk.id,
          translatedLength: translated.text.length,
          translatedFinal: translated.finalized,
          provider: this.translationProvider.key
        });

        await this.writeLog({
          type: 'translation.chunk',
          timestamp: new Date().toISOString(),
          payload: {
            provider: this.translationProvider.key,
            sourceId: chunk.id,
            translatedText: translated.text,
            fallbackUsed: this.snapshot.translationRoute.fallbackUsed
          }
        });
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = this.snapshot.logPathDetail ? `${rawMessage} ${this.snapshot.logPathDetail}` : rawMessage;
        const retryCount = this.snapshot.retryCount + 1;
        this.updateSnapshot({
          retryCount,
          lastError: message,
          healthMessage:
            MODE_CONFIG[mode].translatorKind === 'remote'
              ? '선택한 번역 경로가 실패했습니다. 인증 또는 네트워크를 확인한 뒤 다시 시작하세요.'
              : 'provider 실패를 기록했고 런타임은 재시도를 위해 살아 있습니다.'
        });

        await this.debug('worker.translation.failed', {
          runId,
          chunkId: chunk.id,
          message,
          error
        });

        await this.writeLog({
          type: 'runtime.retry',
          timestamp: new Date().toISOString(),
          payload: {
            retryCount,
            message
          }
        });
        }
      });

      await this.debug('worker.session.running', {
        runId,
        startedAt: this.snapshot.startedAt,
        routeLabel: this.snapshot.routeLabel,
        selectedProvider,
        activeProvider: this.snapshot.translationRoute.active
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = this.snapshot.logPathDetail ? `${rawMessage} ${this.snapshot.logPathDetail}` : rawMessage;
      this.updateSnapshot({
        phase: 'error',
        capture: {
          ...this.snapshot.capture,
          phase: 'error',
          lastError: message,
          guidance: message
        },
        lastError: message,
        healthMessage: '실오디오 캡처 초기화에 실패했습니다.'
      });
      await this.debug('worker.session.start.failed', {
        runId,
        message,
        error
      });
      throw error;
    }
  }

  private async stop() {
    await this.debug('worker.session.stopping', {
      phase: this.snapshot.phase,
      mode: this.snapshot.mode,
      lineCount: this.snapshot.lines.length
    });

    this.activeRunId += 1;

    if (this.snapshot.phase === 'idle') {
      return;
    }

    this.updateSnapshot({
      phase: 'stopping',
      healthMessage: 'provider를 중지하고 로컬 로그를 정리하는 중입니다.'
    });

    await this.sttProvider?.stop();
    this.sttProvider = null;
    this.translationProvider = null;

    await this.writeLog({
      type: 'session.stopped',
      timestamp: new Date().toISOString(),
      payload: {
        retryCount: this.snapshot.retryCount,
        lineCount: this.snapshot.lines.length
      }
    });

    await this.debug('worker.session.stopped', {
      runId: this.activeRunId,
      retryCount: this.snapshot.retryCount,
      lines: this.snapshot.lines.length
    });

    this.updateSnapshot({
      phase: 'idle',
      capture: createCaptureSnapshot(process.platform),
      startedAt: null,
      healthMessage: '중지되었습니다. 다시 시작할 수 있습니다.'
    });
  }
}
