import { createRequire } from 'node:module';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
// A standalone checkout uses its own dev dependency. This workspace can reuse
// the App's already installed builder without changing any App files.
const vite = require.resolve('vite', { paths: [root, resolve(root, '../dsh-desktop')] });
const { build } = await import(pathToFileURL(vite).href);
const output = resolve(root, 'dist/package');
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await build({ configFile: false, root, logLevel: 'warn', build: { outDir: output, emptyOutDir: true, target: 'chrome126', minify: false,
  lib: { entry: resolve(root, 'src/client.jsx'), formats: ['cjs'], fileName: () => 'client.js' },
  rolldownOptions: { external: ['react', 'react/jsx-runtime'], output: {
    banner: 'window.__ModuleLoader__.load({id:"dsh-side-chat",factory:(require)=>{const module={exports:{}};const exports=module.exports;',
    footer: 'return module.exports;}});',
  } },
} });
const { scripts, devDependencies, ...pkg } = metadata;
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'package.json'), JSON.stringify({ ...pkg, main: 'index.js', exports: { '.': './index.js', './client': './client.js', './cordis.patch.yml': './cordis.patch.yml', './package.json': './package.json' }, files: ['index.js', 'host.js', 'remote.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE'] }, null, 2) + '\n');
for (const [source, target] of [['src/index.js', 'index.js'], ['src/host.js', 'host.js'], ['src/remote.js', 'remote.js'], ['cordis.patch.yml', 'cordis.patch.yml'], ['README.md', 'README.md'], ['LICENSE', 'LICENSE']]) await copyFile(resolve(root, source), resolve(output, target));
console.log(`Built ${metadata.name} ${metadata.version} in ${output}`);
