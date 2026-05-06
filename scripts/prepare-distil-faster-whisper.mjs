#!/usr/bin/env node
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const pythonDir = path.join(root, 'vendor', 'python', 'darwin', 'arm64');
const modelDir = path.join(root, 'vendor', 'models', 'darwin', 'arm64', 'distil-large-v3-ct2');
const runtimePython = path.join(pythonDir, 'bin', 'python3');

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
    child.on('error', reject);
  });
}

await rm(pythonDir, { recursive: true, force: true });
await mkdir(path.dirname(pythonDir), { recursive: true });
await mkdir(modelDir, { recursive: true });

const uvPythonPath = (await new Promise((resolve, reject) => {
  let stdout = '';
  const child = spawn('uv', ['python', 'find', '3.11'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit']
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.on('exit', (code) => {
    if (code === 0) resolve(stdout.trim());
    else reject(new Error(`uv python find 3.11 exited with code ${code ?? 'unknown'}`));
  });
  child.on('error', reject);
}));
const uvRuntimeDir = await realpath(path.dirname(path.dirname(uvPythonPath)));
await run('rsync', ['-a', `${uvRuntimeDir}/`, `${pythonDir}/`]);
await run('uv', ['pip', 'install', '--python', runtimePython, '--target', path.join(pythonDir, 'lib', 'python3.11', 'site-packages'), 'faster-whisper==1.1.1', 'huggingface-hub==0.34.4']);
await run(runtimePython, ['-c', [
  'from huggingface_hub import snapshot_download',
  `snapshot_download(repo_id="Systran/faster-distil-whisper-large-v3", local_dir=r"${modelDir}", local_dir_use_symlinks=False)`
].join('; ')]);

console.log(JSON.stringify({
  prepared: true,
  pythonDir,
  modelDir,
  runtimePython,
  bundledPythonSource: uvRuntimeDir
}, null, 2));
