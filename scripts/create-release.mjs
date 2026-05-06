import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const pkg = JSON.parse(execSync('node -p "JSON.stringify(require(\'./package.json\'))"', { cwd: root, encoding: 'utf8' }));
const stamp = process.env.RELEASE_STAMP || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const version = pkg.version;
const releaseRoot = path.join(root, 'release');
const buildLegacySource = process.argv.includes('--legacy-source');

if (!buildLegacySource) {
  console.log('No legacy source bundle requested.');
  process.exit(0);
}

const folderName = `JP-KO-Translator-${version}-${stamp}-windows-source-bundle`;
const outDir = path.join(releaseRoot, folderName);
const zipPath = path.join(releaseRoot, `${folderName}.zip`);

if (!existsSync(path.join(root, 'dist')) || !existsSync(path.join(root, 'dist-electron'))) {
  throw new Error('Build outputs are missing. Run npm run build first.');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(path.join(outDir, 'app'), { recursive: true });
mkdirSync(path.join(outDir, 'docs'), { recursive: true });

cpSync(path.join(root, 'dist'), path.join(outDir, 'app', 'dist'), { recursive: true });
cpSync(path.join(root, 'dist-electron'), path.join(outDir, 'app', 'dist-electron'), { recursive: true });
cpSync(path.join(root, 'package.json'), path.join(outDir, 'app', 'package.json'));
cpSync(path.join(root, 'package-lock.json'), path.join(outDir, 'app', 'package-lock.json'));
cpSync(path.join(root, 'README.md'), path.join(outDir, 'docs', 'README.md'));
cpSync(path.join(root, 'docs', 'WINDOWS_RELEASE_GUIDE.md'), path.join(outDir, 'docs', 'WINDOWS_RELEASE_GUIDE.md'));
cpSync(path.join(root, 'docs', 'QA_RELEASE_CHECKLIST.md'), path.join(outDir, 'docs', 'QA_RELEASE_CHECKLIST.md'));
cpSync(path.join(root, 'scripts', 'launch-windows.cmd'), path.join(outDir, 'JP-KO Translator.cmd'));

writeFileSync(
  path.join(outDir, 'VERSION.txt'),
  [
    'Product: JP-KO Translator',
    `Version: ${version}`,
    `Release stamp: ${stamp}`,
    'Package type: windows-legacy-source-bundle',
    'Primary user package: use the portable .exe build instead of this bundle whenever possible.',
    'Runtime requirement: Node.js LTS must be installed on Windows before launch.',
    'Failure diagnostics: see launcher.log next to JP-KO Translator.cmd.'
  ].join('\n') + '\n',
  'utf8'
);

rmSync(zipPath, { force: true });
execSync(`zip -qry ${JSON.stringify(zipPath)} ${JSON.stringify(folderName)}`, { cwd: releaseRoot, stdio: 'inherit' });

console.log(zipPath);
