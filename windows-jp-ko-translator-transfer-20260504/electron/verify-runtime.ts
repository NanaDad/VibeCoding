import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { HostPlatform, RuntimeMode, TranslationProviderId, WorkerSnapshot } from './shared/runtime-contract.js';
import { runLiveCaptureProbe } from './worker/live-capture.js';
import { runTranslationProbe, TranslatorRuntime } from './worker/runtime-core.js';

interface ParsedArgs {
  mode: RuntimeMode;
  provider: TranslationProviderId;
  sampleText: string;
  timeoutMs: number;
  reportFile: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      values.set(key, '1');
      continue;
    }
    values.set(key, next);
    index += 1;
  }

  const mode = (values.get('mode') as RuntimeMode | undefined) ?? 'hybrid';
  const provider = (values.get('provider') as TranslationProviderId | undefined) ?? 'auto';
  const sampleText =
    values.get('text')
    ?? '音声入力と翻訳経路を実機で確認しています。';
  const timeoutMs = Number.parseInt(values.get('timeout-ms') ?? '', 10);
  const reportFile = values.get('report-file')?.trim() || null;

  return {
    mode,
    provider,
    sampleText,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12_000,
    reportFile
  };
}

async function waitForRuntimeResult(
  runtime: TranslatorRuntime,
  timeoutMs: number
): Promise<{
  status: 'translated' | 'capture-ready-only' | 'failed';
  snapshot: WorkerSnapshot;
}> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = runtime.getSnapshot();
    const translatedLine = snapshot.lines.find((line) => line.translatedText.trim());
    if (translatedLine) {
      return {
        status: 'translated',
        snapshot
      };
    }
    if (snapshot.phase === 'error') {
      return {
        status: 'failed',
        snapshot
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const snapshot = runtime.getSnapshot();
  return {
    status: snapshot.capture.phase === 'capturing' ? 'capture-ready-only' : 'failed',
    snapshot
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = process.platform as HostPlatform;
  const providerOrder: TranslationProviderId[] = ['codex-auth', 'chatgpt-api', 'gemini-api', 'deepl-fallback'];

  const translationResults = [];
  for (const provider of providerOrder) {
    translationResults.push(await runTranslationProbe(provider, args.sampleText));
  }

  let captureResult:
    | Awaited<ReturnType<typeof runLiveCaptureProbe>>
    | null = null;
  let captureProbeError: string | null = null;

  try {
    captureResult = await runLiveCaptureProbe(platform, {
      timeoutMs: Math.min(args.timeoutMs, 8_000)
    });
  } catch (error) {
    captureProbeError = error instanceof Error ? error.message : String(error);
  }

  const runtime = new TranslatorRuntime({
    onSnapshot: () => undefined
  });

  let e2eStatus: 'translated' | 'capture-ready-only' | 'failed' = 'failed';
  let e2eSnapshot = runtime.getSnapshot();
  let e2eError: string | null = null;

  try {
    await runtime.handleCommand({
      type: 'start',
      mode: args.mode,
      provider: args.provider,
      logDirectory: path.join(os.tmpdir(), 'jp-ko-runtime-probe-logs'),
      debugLogDirectory: path.join(os.tmpdir(), 'jp-ko-runtime-probe-logs')
    });
    const result = await waitForRuntimeResult(runtime, args.timeoutMs);
    e2eStatus = result.status;
    e2eSnapshot = result.snapshot;
  } catch (error) {
    e2eError = error instanceof Error ? error.message : String(error);
    e2eSnapshot = runtime.getSnapshot();
  } finally {
    await runtime.handleCommand({ type: 'stop' }).catch(() => undefined);
  }

  const summary = {
    timestamp: new Date().toISOString(),
    platform,
    requested: {
      mode: args.mode,
      provider: args.provider,
      sampleText: args.sampleText,
      timeoutMs: args.timeoutMs
    },
    translationResults,
    captureProbe: captureResult
      ? {
          success: captureResult.ready,
          ...captureResult
        }
      : {
          success: false,
          error: captureProbeError
        },
    e2e: {
      status: e2eStatus,
      error: e2eError,
      phase: e2eSnapshot.phase,
      capturePhase: e2eSnapshot.capture.phase,
      lastError: e2eSnapshot.lastError,
      routeLabel: e2eSnapshot.routeLabel,
      activeProvider: e2eSnapshot.translationRoute.active,
      fallbackUsed: e2eSnapshot.translationRoute.fallbackUsed,
      lineCount: e2eSnapshot.lines.length,
      translatedLines: e2eSnapshot.lines.filter((line) => line.translatedText.trim()).length,
      transcriptPreview: e2eSnapshot.lines[0]?.sourceText ?? null,
      translationPreview: e2eSnapshot.lines[0]?.translatedText ?? null
    }
  };

  if (args.reportFile) {
    await mkdir(path.dirname(args.reportFile), { recursive: true });
    await writeFile(args.reportFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));

  const hasSuccessfulProvider = translationResults.some((result) => result.success);
  const e2eOkay = e2eStatus === 'translated';
  process.exitCode = hasSuccessfulProvider && captureResult?.ready && e2eOkay ? 0 : 1;
}

void main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        fatal: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
