import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');
const vendorRoot = path.join(root, 'vendor', 'bin', 'win32', 'x64');
const tempRoot = path.join(root, '.tmp-windows-tools');
const ffmpegPath = path.join(vendorRoot, 'ffmpeg.exe');
const whisperCliPath = path.join(vendorRoot, 'whisper-cli.exe');
const whisperStreamPath = path.join(vendorRoot, 'stream.exe');
const whisperModelPath = path.join(vendorRoot, 'ggml-base.bin');
const whisperRuntimeDlls = ['SDL2.dll', 'whisper.dll'];
const ffmpegUrl = process.env.FFMPEG_WINDOWS_URL || 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const whisperZipUrl = process.env.WHISPER_WINDOWS_URL || 'https://remotion-ffmpeg-binaries.s3.eu-central-1.amazonaws.com/whisper-bin-x64-1-5-5.zip';
const whisperModelUrl = process.env.WHISPER_MODEL_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';

function download(url, destination) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'openclaw-jp-ko-translator' } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      const file = createWriteStream(destination);
      pipeline(response, file).then(resolve).catch(reject);
    }).on('error', reject);
  });
}

function walkFiles(rootPath) {
  const entries = readdirSync(rootPath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(rootPath, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function extractFirstMatch(archivePath, extractRoot, matcher) {
  execFileSync('tar', ['-xf', archivePath, '-C', extractRoot], { stdio: 'inherit' });
  const pattern = new RegExp(matcher);
  const found = walkFiles(extractRoot).find((filePath) => pattern.test(filePath));
  if (!found) {
    throw new Error(`Archive ${archivePath} did not contain a file matching ${matcher}`);
  }
  return found;
}

function copyWhisperRuntimeFiles(executablePath) {
  const sourceDirectory = path.dirname(executablePath);
  const streamPath = path.join(sourceDirectory, 'stream.exe');
  if (existsSync(streamPath)) {
    copyFileSync(streamPath, whisperStreamPath);
    chmodSync(whisperStreamPath, 0o755);
  }
  for (const dllName of whisperRuntimeDlls) {
    const sourcePath = path.join(sourceDirectory, dllName);
    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, path.join(vendorRoot, dllName));
      chmodSync(path.join(vendorRoot, dllName), 0o755);
    }
  }
}

function ffmpegSupportsInputDevice(targetPath, inputDevice) {
  if (!existsSync(targetPath)) {
    return false;
  }
  try {
    const output = execFileSync(targetPath, ['-hide_banner', '-devices'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return new RegExp(`\\b${inputDevice}\\b`, 'i').test(output);
  } catch {
    return false;
  }
}

function ffmpegHasWindowsAudioInput(targetPath) {
  return ffmpegSupportsInputDevice(targetPath, 'wasapi') || ffmpegSupportsInputDevice(targetPath, 'dshow');
}

mkdirSync(vendorRoot, { recursive: true });
if (existsSync(ffmpegPath) && !ffmpegHasWindowsAudioInput(ffmpegPath)) {
  console.warn('Existing ffmpeg.exe does not support Windows audio capture; downloading a compatible build.');
  rmSync(ffmpegPath, { force: true });
}

if (
  existsSync(ffmpegPath)
  && existsSync(whisperCliPath)
  && existsSync(whisperStreamPath)
  && existsSync(whisperModelPath)
  && whisperRuntimeDlls.every((dllName) => existsSync(path.join(vendorRoot, dllName)))
) {
  console.log(vendorRoot);
  process.exit(0);
}

rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(tempRoot, { recursive: true });

if (!existsSync(ffmpegPath)) {
  const archivePath = path.join(tempRoot, 'ffmpeg-win64.zip');
  const extractRoot = path.join(tempRoot, 'ffmpeg-extract');
  mkdirSync(extractRoot, { recursive: true });
  await download(ffmpegUrl, archivePath);
  const extractedPath = extractFirstMatch(archivePath, extractRoot, 'ffmpeg\\.exe$');
  copyFileSync(extractedPath, ffmpegPath);
  if (!ffmpegHasWindowsAudioInput(ffmpegPath)) {
    rmSync(ffmpegPath, { force: true });
    throw new Error('Downloaded ffmpeg.exe does not support Windows audio capture. Set FFMPEG_WINDOWS_URL to a Windows build with wasapi or dshow input.');
  }
  if (!ffmpegSupportsInputDevice(ffmpegPath, 'wasapi')) {
    console.warn('Downloaded ffmpeg.exe does not expose WASAPI. The app will require a DirectShow loopback device such as Stereo Mix or virtual-audio-capturer.');
  }
  chmodSync(ffmpegPath, 0o755);
}

if (!existsSync(whisperCliPath)) {
  const archivePath = path.join(tempRoot, 'whisper-win64.zip');
  const extractRoot = path.join(tempRoot, 'whisper-extract');
  mkdirSync(extractRoot, { recursive: true });
  await download(whisperZipUrl, archivePath);
  const extractedPath = extractFirstMatch(archivePath, extractRoot, 'whisper-cli\\.exe$|whisper\\.exe$|main\\.exe$');
  copyFileSync(extractedPath, whisperCliPath);
  copyWhisperRuntimeFiles(extractedPath);
  chmodSync(whisperCliPath, 0o755);
}

if (
  existsSync(whisperCliPath)
  && (!existsSync(whisperStreamPath) || !whisperRuntimeDlls.every((dllName) => existsSync(path.join(vendorRoot, dllName))))
) {
  const archivePath = path.join(tempRoot, 'whisper-win64.zip');
  const extractRoot = path.join(tempRoot, 'whisper-extract');
  mkdirSync(extractRoot, { recursive: true });
  await download(whisperZipUrl, archivePath);
  const extractedPath = extractFirstMatch(archivePath, extractRoot, 'whisper-cli\\.exe$|whisper\\.exe$|main\\.exe$');
  copyWhisperRuntimeFiles(extractedPath);
}

if (!existsSync(whisperModelPath)) {
  await download(whisperModelUrl, whisperModelPath);
  chmodSync(whisperModelPath, 0o644);
}

rmSync(tempRoot, { recursive: true, force: true });
console.log(vendorRoot);
