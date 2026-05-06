import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

interface DebugLoggerOptions {
  logDirectory: string;
  scope: string;
}

export interface DebugLogger {
  readonly textPath: string;
  readonly jsonlPath: string;
  log(event: string, payload?: Record<string, unknown>): Promise<void>;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    };
  }

  return {
    message: String(error)
  };
}

function stringifyValue(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify(serializeError(value));
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createDebugLogger(options: DebugLoggerOptions): DebugLogger {
  const baseName = `${options.scope}-debug`;
  const textPath = path.join(options.logDirectory, `${baseName}.log`);
  const jsonlPath = path.join(options.logDirectory, `${baseName}.jsonl`);

  return {
    textPath,
    jsonlPath,
    async log(event: string, payload: Record<string, unknown> = {}) {
      await mkdir(options.logDirectory, { recursive: true });
      const timestamp = new Date().toISOString();
      const serializedPayload = Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [
          key,
          value instanceof Error ? serializeError(value) : value
        ])
      );

      const jsonlLine = `${JSON.stringify({
        timestamp,
        scope: options.scope,
        event,
        payload: serializedPayload
      })}\n`;
      const textLine = `[${timestamp}] [${options.scope}] ${event} ${Object.entries(serializedPayload)
        .map(([key, value]) => `${key}=${stringifyValue(value)}`)
        .join(' ')}\n`;

      await Promise.all([
        appendFile(jsonlPath, jsonlLine, 'utf8'),
        appendFile(textPath, textLine, 'utf8')
      ]);
    }
  };
}
