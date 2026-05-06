import type {
  CaptureBackend,
  CaptureBackendOption,
  CaptureSnapshot,
  HostPlatform
} from './runtime-contract.js';

const WINDOWS_BACKENDS: CaptureBackendOption[] = [
  {
    key: 'windows-wasapi-loopback',
    label: 'Windows WASAPI Loopback',
    availability: 'native-ready',
    selectable: true,
    recommended: true,
    description: 'Windows 데스크톱 재생 오디오를 위한 기본 시스템 캡처 경로입니다.',
    setupHint: '추가 가상 장치가 필요하지 않습니다. 런타임은 기본 재생 장치를 대상으로 합니다.'
  }
];

const MACOS_BACKENDS: CaptureBackendOption[] = [
  {
    key: 'macos-screencapturekit-native',
    label: 'macOS ScreenCaptureKit Native',
    availability: 'native-ready',
    selectable: true,
    recommended: true,
    description: '네이티브 Swift helper가 ScreenCaptureKit 오디오 스트림을 직접 받아 segment 파일로 기록하는 기본 경로입니다.',
    setupHint: '추가 가상 장치나 수동 라우팅이 필요하지 않습니다. macOS 13+와 화면 기록 권한이 필요합니다.'
  },
  {
    key: 'macos-coreaudio-tap',
    label: 'macOS CoreAudio Tap',
    availability: 'planned',
    selectable: false,
    recommended: false,
    description: '이전 CoreAudio process tap 실험 경로입니다. 현재 기본 경로에서 제외했습니다.',
    setupHint: '현재는 사용하지 않습니다.'
  },
  {
    key: 'macos-screencapturekit',
    label: 'macOS ScreenCaptureKit Audio',
    availability: 'planned',
    selectable: false,
    recommended: false,
    description: '이전 Electron helper 기반 ScreenCaptureKit 경로입니다. 이 호스트에서는 브라우저 capture API 제약으로 막혀 있어 기본값에서 제외했습니다.',
    setupHint: '현재는 사용하지 않습니다.'
  },
  {
    key: 'macos-avfoundation-input',
    label: 'macOS AVFoundation Input',
    availability: 'manual-setup',
    selectable: true,
    recommended: false,
    description: '입력 장치를 직접 캡처하는 레거시 경로입니다. 시스템 오디오는 가상 장치 라우팅이 필요합니다.',
    setupHint: '직접 시스템 오디오가 막힐 때만 예비 경로로 사용하세요. 기본값은 ScreenCaptureKit입니다.'
  },
  {
    key: 'macos-blackhole',
    label: 'macOS BlackHole',
    availability: 'manual-setup',
    selectable: false,
    recommended: false,
    description: '시스템 출력을 BlackHole 가상 장치로 보낸 뒤 캡처하는 수동 우회 경로입니다.',
    setupHint: 'ScreenCaptureKit 권한 또는 호환성 문제가 있을 때만 사용하세요.'
  },
  {
    key: 'manual-audio-routing',
    label: 'Manual Audio Routing',
    availability: 'manual-setup',
    selectable: true,
    recommended: false,
    description: '네이티브 macOS 캡처가 완전히 붙기 전, 수동 라우팅 또는 외부 미러링 입력으로 점검하는 모드입니다.',
    setupHint: '네이티브 macOS 캡처 브리지가 없더라도 앱 셸과 worker 흐름을 먼저 점검하고 싶을 때 사용합니다.'
  }
];

const FALLBACK_BACKENDS: CaptureBackendOption[] = [
  {
    key: 'unavailable',
    label: 'No Native Capture Backend',
    availability: 'unsupported',
    selectable: false,
    recommended: true,
    description: '현재 빌드에는 이 호스트용 1급 시스템 오디오 백엔드가 없습니다.',
    setupHint: '런타임은 fixture transcript 이벤트 기반으로 UI와 흐름 점검에 계속 사용할 수 있습니다.'
  }
];

function resolveBackends(platform: HostPlatform) {
  if (platform === 'win32') {
    return WINDOWS_BACKENDS;
  }

  if (platform === 'darwin') {
    return MACOS_BACKENDS;
  }

  return FALLBACK_BACKENDS;
}

function preferredBackend(platform: HostPlatform, backends: CaptureBackendOption[]) {
  if (platform === 'win32') {
    return backends[0];
  }

  if (platform === 'darwin') {
    return backends.find((backend) => backend.recommended) ?? backends[0];
  }

  return backends[0];
}

export function createCaptureSnapshot(platform: HostPlatform): CaptureSnapshot {
  const availableBackends = resolveBackends(platform);
  const selected = preferredBackend(platform, availableBackends);

  if (platform === 'win32') {
    return {
      phase: 'ready',
      backend: selected.key,
      target: 'system-audio',
      platform,
      deviceLabel: 'Default Windows Output (auto loopback)',
      supportsSystemAudio: true,
      recoveryAttempts: 0,
      guidance: 'Windows 재생 오디오 캡처용으로 WASAPI loopback 백엔드가 선택되어 있습니다. 별도 가상 장치 없이 현재 기본 출력 장치를 자동으로 따라갑니다.',
      lastError: null,
      backendLabel: selected.label,
      backendAvailability: selected.availability,
      availableBackends
    };
  }

  if (platform === 'darwin') {
    return {
      phase: 'ready',
      backend: selected.key,
      target: 'system-audio',
      platform,
      deviceLabel: '자동 선택 대기 중',
      supportsSystemAudio: true,
      recoveryAttempts: 0,
      guidance:
        'macOS ScreenCaptureKit native helper 경로를 사용합니다. 추가 가상 장치 없이 시스템 오디오를 직접 segment 파일로 기록합니다.',
      lastError: null,
      backendLabel: selected.label,
      backendAvailability: selected.availability,
      availableBackends
    };
  }

  return {
    phase: 'unsupported',
    backend: 'unavailable',
    target: 'system-audio',
    platform,
    deviceLabel: null,
    supportsSystemAudio: false,
    recoveryAttempts: 0,
    guidance: '현재 빌드 기준으로 이 호스트는 Windows/macOS 캡처 지원 범위 밖입니다.',
    lastError: null,
    backendLabel: availableBackends[0].label,
    backendAvailability: availableBackends[0].availability,
    availableBackends
  };
}

export function resolveCaptureBackendOption(
  backend: CaptureBackend,
  platform: HostPlatform
): CaptureBackendOption | undefined {
  return resolveBackends(platform).find((option) => option.key === backend);
}
