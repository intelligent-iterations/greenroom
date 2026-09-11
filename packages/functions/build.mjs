/**
 * Produces a self-contained deploy directory at dist/.
 *
 * Firebase uploads the `source` directory and runs `npm install` inside it on
 * Cloud Build. That install cannot resolve pnpm's `workspace:*` protocol, and
 * moving the workspace dependency to devDependencies is not enough — Cloud
 * Build installs those too. So the shared package is bundled into the output
 * and the emitted package.json never mentions it.
 *
 * Only genuinely npm-installable packages stay external. Bundling
 * firebase-functions would break the deploy-time discovery that reads the
 * module to find exported functions.
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';

const EXTERNAL = ['firebase-functions', 'firebase-admin', 'zod'];
const source = JSON.parse(await readFile('package.json', 'utf8'));

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.js',
  external: EXTERNAL,
  sourcemap: true,
  logLevel: 'info',
});

// Carry through only the versions of packages we actually left external, so the
// deployed manifest cannot drift from what the bundle expects at runtime.
const dependencies = Object.fromEntries(
  EXTERNAL.map((name) => {
    const version = source.dependencies?.[name];
    if (!version) throw new Error(`${name} is external but not in dependencies`);
    return [name, version];
  }),
);

await writeFile(
  'dist/package.json',
  JSON.stringify(
    {
      name: 'greenroom-functions',
      version: source.version,
      private: true,
      type: 'module',
      main: 'index.js',
      engines: source.engines,
      dependencies,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

// firebase-tools resolves firebase-functions from the source directory to
// discover exported functions *before* uploading, so the deploy directory needs
// the SDK reachable. Linking the workspace's already-installed modules is
// cheaper and more deterministic than a second npm install, and firebase.json
// keeps node_modules out of the upload.
await rm('dist/node_modules', { force: true, recursive: false }).catch(() => {});
await symlink('../node_modules', 'dist/node_modules', 'dir');

console.log(`deploy directory ready: dist/ (${Object.keys(dependencies).length} runtime deps)`);
