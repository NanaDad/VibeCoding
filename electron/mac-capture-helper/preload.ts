import { ipcRenderer } from 'electron';

function emit(channel: 'mac-system-audio:status' | 'mac-system-audio:error', payload: Record<string, unknown>) {
  ipcRenderer.send(channel, {
    ...payload,
    timestamp: new Date().toISOString()
  });
}

let activeStream: MediaStream | null = null;
let activeRecorder: MediaRecorder | null = null;
let startupWatchdog: number | null = null;

function clearStartupWatchdog() {
  if (startupWatchdog !== null) {
    window.clearTimeout(startupWatchdog);
    startupWatchdog = null;
  }
}

function stopActiveCapture() {
  clearStartupWatchdog();
  activeRecorder?.stop();
  activeRecorder = null;
  activeStream?.getTracks().forEach((track) => track.stop());
  activeStream = null;
}

async function startCapture() {
  try {
    const timesliceMs = Number.parseInt(new URLSearchParams(window.location.search).get('timesliceMs') ?? '', 10);
    startupWatchdog = window.setTimeout(() => {
      emit('mac-system-audio:error', {
        phase: 'startup-timeout',
        message: 'ScreenCaptureKit system audio capture did not start within 10 seconds. The helper window may need to stay visible until macOS permission prompts or the capture sheet are accepted.'
      });
    }, 10_000);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 1,
        width: { ideal: 2, max: 8 },
        height: { ideal: 2, max: 8 }
      } as MediaTrackConstraints,
      audio: true
    });

    activeStream = stream;
    clearStartupWatchdog();
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();

    emit('mac-system-audio:status', {
      phase: 'stream-opened',
      audioTrackCount: audioTracks.length,
      videoTrackCount: videoTracks.length,
      audioTrackLabels: audioTracks.map((track) => track.label),
      videoTrackLabels: videoTracks.map((track) => track.label)
    });

    if (audioTracks.length === 0) {
      throw new Error('ScreenCaptureKit stream opened but no system audio track was attached.');
    }

    const supportedMimeType = [
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'audio/webm;codecs=opus',
      'audio/webm'
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));

    let index = 0;
    let readyEmitted = false;
    const recorder = new MediaRecorder(stream, supportedMimeType ? {
      mimeType: supportedMimeType,
      audioBitsPerSecond: 128000,
      videoBitsPerSecond: 32000
    } : {
      audioBitsPerSecond: 128000,
      videoBitsPerSecond: 32000
    });
    activeRecorder = recorder;

    recorder.addEventListener('start', () => {
      emit('mac-system-audio:status', {
        phase: 'capture-started',
        backendLabel: 'macOS ScreenCaptureKit Audio',
        deviceLabel: audioTracks[0]?.label || 'System Audio',
        mimeType: recorder.mimeType || supportedMimeType || 'default',
        keepingVideoTrackAlive: videoTracks.length > 0
      });
    });

    recorder.addEventListener('dataavailable', async (event) => {
      emit('mac-system-audio:status', {
        phase: 'dataavailable',
        index,
        size: event.data?.size ?? 0,
        recorderState: recorder.state
      });

      if (!event.data || event.data.size === 0) {
        return;
      }

      const arrayBuffer = await event.data.arrayBuffer();
      await ipcRenderer.invoke('mac-system-audio:write-segment', {
        index,
        buffer: Array.from(new Uint8Array(arrayBuffer))
      });
      if (!readyEmitted) {
        readyEmitted = true;
        emit('mac-system-audio:status', {
          phase: 'ready',
          backendLabel: 'macOS ScreenCaptureKit Audio',
          deviceLabel: audioTracks[0]?.label || 'System Audio',
          mimeType: recorder.mimeType || supportedMimeType || 'default',
          keepingVideoTrackAlive: videoTracks.length > 0,
          firstChunkIndex: index,
          firstChunkBytes: event.data.size
        });
      }
      index += 1;
    });

    recorder.addEventListener('stop', () => {
      emit('mac-system-audio:status', {
        phase: 'recorder-stopped',
        recorderState: recorder.state
      });
    });

    recorder.addEventListener('error', (event) => {
      const message = event.error?.message || 'MediaRecorder failed.';
      emit('mac-system-audio:error', {
        phase: 'recording-error',
        message
      });
    });

    for (const track of [...audioTracks, ...videoTracks]) {
      track.addEventListener('ended', () => {
        emit('mac-system-audio:error', {
          phase: 'track-ended',
          kind: track.kind,
          label: track.label,
          readyState: track.readyState,
          message: `${track.kind} track ended.`
        });
      });
    }

    recorder.start(Number.isFinite(timesliceMs) && timesliceMs >= 500 ? timesliceMs : 4000);
  } catch (error) {
    clearStartupWatchdog();
    emit('mac-system-audio:error', {
      phase: 'startup-error',
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : null,
      stack: error instanceof Error ? error.stack : null
    });
  }
}

window.addEventListener('beforeunload', () => {
  stopActiveCapture();
});

window.addEventListener('DOMContentLoaded', () => {
  void startCapture();
});
