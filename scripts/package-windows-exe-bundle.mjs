import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const stamp = process.env.RELEASE_STAMP || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const pkg = JSON.parse(execSync('node -p "JSON.stringify(require(\'./package.json\'))"', { cwd: root, encoding: 'utf8' }));
const version = pkg.version;
const releaseRoot = path.join(root, 'release');
const builderOut = path.join(releaseRoot, 'electron-builder');
const sourceDir = path.join(builderOut, 'win-unpacked');
const folderName = `wjkt-win-x64`;
const outDir = path.join(releaseRoot, folderName);
const zipPath = path.join(releaseRoot, `${folderName}.zip`);

if (!existsSync(path.join(sourceDir, 'JP-KO Translator.exe'))) {
  throw new Error('Missing win-unpacked/JP-KO Translator.exe. Run the electron-builder dir build first.');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(sourceDir, outDir, { recursive: true });

rmSync(zipPath, { force: true });
execSync(`zip -qry ${JSON.stringify(zipPath)} ${JSON.stringify(folderName)}`, {
  cwd: releaseRoot,
  stdio: 'inherit'
});

console.log(zipPath);
