// Bundles the server (and the workspace `shared` package) into dist/index.js.
// Runtime dependencies stay external and are installed in the image with `pnpm deploy --prod`.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@evobridge/'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...external, 'pino-pretty'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { 'process.env.EVOBRIDGE_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info',
});
