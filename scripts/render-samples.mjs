// Writes artifacts/samples/*.html (examples A–F, 60 lines in every template, Letter) through the Jest
// environment, which already resolves the TypeScript sources and the "@/" imports. Open a file with
// `open -a Safari artifacts/samples/example-A.html` (optional visual check, no screenshot needed).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npx', ['jest', 'src/render/samples.test.ts', '--silent'], {
  cwd: root,
  env: { ...process.env, RENDER_SAMPLES: '1' },
  stdio: 'inherit',
});
if (result.status === 0) console.log('samples written to artifacts/samples/');
process.exit(result.status ?? 1);
