import { TranslatorRuntime, type RuntimeCommand } from './runtime-core.js';

const runtime = new TranslatorRuntime({
  onSnapshot(snapshot) {
    if (process.send) {
      process.send({ type: 'status', payload: snapshot });
    }
  }
});

function emitSnapshot() {
  if (process.send) {
    process.send({ type: 'status', payload: runtime.getSnapshot() });
  }
}

async function reportFatal(event: string, error?: unknown) {
  try {
    await runtime.reportHostIssue(event, error);
  } catch {
    // Best-effort reporting only.
  }
}

process.on('message', async (message: RuntimeCommand) => {
  try {
    await runtime.handleCommand(message);
  } catch (error) {
    await reportFatal('worker.command.failed', error);
    if (process.send) {
      process.send({
        type: 'status',
        payload: {
          ...runtime.getSnapshot(),
          phase: 'error',
          lastError: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
});

process.on('disconnect', () => {
  void reportFatal('worker.process.disconnect');
});

process.on('SIGTERM', () => {
  void reportFatal('worker.process.sigterm');
});

process.on('SIGINT', () => {
  void reportFatal('worker.process.sigint');
});

process.on('uncaughtException', (error) => {
  void reportFatal('worker.process.uncaught-exception', error);
});

process.on('unhandledRejection', (reason) => {
  void reportFatal('worker.process.unhandled-rejection', reason);
});

emitSnapshot();
