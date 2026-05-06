import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ProviderConfigValues {
  chatgptApiKey: string;
  openaiBaseUrl: string;
  chatgptModel: string;
  geminiApiKey: string;
  geminiBaseUrl: string;
  geminiModel: string;
  deeplApiKey: string;
  deeplBaseUrl: string;
  codexModel: string;
  macosCaptureDevice: string;
  windowsCaptureDevice: string;
  ffmpegPath: string;
  whisperPath: string;
  whisperModelPath: string;
  userContext: string;
  glossary: string;
}

export interface ProviderConfigState {
  values: ProviderConfigValues;
  codexAuthPath: string;
}

const defaultValues: ProviderConfigValues = {
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
};

export function createDefaultProviderConfigState(): ProviderConfigState {
  return {
    values: { ...defaultValues },
    codexAuthPath: path.join(os.homedir(), '.codex', 'auth.json')
  };
}

export async function loadProviderConfigState(userDataPath: string): Promise<ProviderConfigState> {
  const target = path.join(userDataPath, 'provider-config.json');
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderConfigState> & { values?: Partial<ProviderConfigValues> };
    return {
      codexAuthPath: parsed.codexAuthPath || createDefaultProviderConfigState().codexAuthPath,
      values: {
        ...defaultValues,
        ...(parsed.values || {})
      }
    };
  } catch {
    return createDefaultProviderConfigState();
  }
}

export async function saveProviderConfigState(userDataPath: string, next: ProviderConfigState): Promise<ProviderConfigState> {
  const target = path.join(userDataPath, 'provider-config.json');
  await mkdir(path.dirname(target), { recursive: true });
  const normalized: ProviderConfigState = {
    codexAuthPath: next.codexAuthPath || createDefaultProviderConfigState().codexAuthPath,
    values: {
      ...defaultValues,
      ...next.values
    }
  };
  await writeFile(target, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function buildWorkerEnv(config: ProviderConfigState) {
  const nextEnv: Record<string, string> = {};
  const setIf = (key: string, value: string) => {
    if (value.trim()) {
      nextEnv[key] = value.trim();
    }
  };

  setIf('CHATGPT_API_KEY', config.values.chatgptApiKey);
  setIf('OPENAI_API_KEY', config.values.chatgptApiKey);
  setIf('OPENAI_BASE_URL', config.values.openaiBaseUrl);
  setIf('CHATGPT_TRANSLATION_MODEL', config.values.chatgptModel);
  setIf('GEMINI_API_KEY', config.values.geminiApiKey);
  setIf('GEMINI_BASE_URL', config.values.geminiBaseUrl);
  setIf('GEMINI_TRANSLATION_MODEL', config.values.geminiModel);
  setIf('DEEPL_API_KEY', config.values.deeplApiKey);
  setIf('DEEPL_BASE_URL', config.values.deeplBaseUrl);
  setIf('CODEX_TRANSLATION_MODEL', config.values.codexModel);
  setIf('CODEX_AUTH_PATH', config.codexAuthPath);
  setIf('MACOS_TRANSLATOR_CAPTURE_DEVICE', config.values.macosCaptureDevice);
  setIf('WINDOWS_TRANSLATOR_CAPTURE_DEVICE', config.values.windowsCaptureDevice);
  setIf('FFMPEG_PATH', config.values.ffmpegPath);
  setIf('WHISPER_PATH', config.values.whisperPath);
  setIf('WHISPER_MODEL_PATH', config.values.whisperModelPath);
  setIf('TRANSLATOR_USER_CONTEXT', config.values.userContext);
  setIf('TRANSLATOR_GLOSSARY', config.values.glossary);

  return nextEnv;
}
