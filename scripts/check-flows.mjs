// Validates the Maestro flows before a run (a YAML that fails to parse prints only "Parsing Failed"):
// every file parses, has the `appId` header + commands, runFlow files exist, every `id:` is a testID in src/,
// and every flow name is listed in config.yaml's flowsOrder. Usage: node scripts/check-flows.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = new URL('..', import.meta.url).pathname;
const flowDir = join(root, '.maestro');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') || e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  );
}
const source = walk(join(root, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
// testIDs are literal ("add-line") or template literals (`line-${i}`): turn the latter into prefix patterns.
const literalIds = new Set([...source.matchAll(/testID="([^"]+)"/g)].map((m) => m[1]));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateIds = [...source.matchAll(/testID=\{`([^`]+)`\}/g)].map((m) => new RegExp('^' + m[1].split(/\$\{[^}]*\}/).map(escapeRe).join('.+') + '$'));
const hasId = (id) => literalIds.has(id) || templateIds.some((re) => re.test(id)) || source.includes(`'${id}'`) || source.includes(`"${id}"`);

const errors = [];
const names = [];
const files = readdirSync(flowDir, { recursive: true }).filter((f) => String(f).endsWith('.yaml') && !String(f).endsWith('config.yaml'));
for (const f of files) {
  const path = join(flowDir, String(f));
  let docs;
  try {
    docs = yaml.loadAll(readFileSync(path, 'utf8'));
  } catch (e) {
    errors.push(`${f}: YAML does not parse: ${e.message.split('\n')[0]}`);
    continue;
  }
  if (docs.length !== 2 || !docs[0]?.appId || !Array.isArray(docs[1])) {
    errors.push(`${f}: needs a header with appId, then ---, then a list of commands`);
    continue;
  }
  if (!String(f).startsWith('subflows') && !String(f).startsWith('release')) names.push(docs[0].name);
  const visit = (cmds) => {
    for (const cmd of cmds ?? []) {
      if (typeof cmd !== 'object' || cmd === null) continue;
      for (const [key, value] of Object.entries(cmd)) {
        if (key === 'runFlow') {
          const file = typeof value === 'string' ? value : value?.file;
          if (file && !existsSync(join(dirname(path), file))) errors.push(`${f}: runFlow file ${file} not found`);
          visit(value?.commands);
        }
        const id = value && typeof value === 'object' ? value.id ?? value.element?.id ?? value.visible?.id : undefined;
        if (typeof id === 'string' && !id.includes('.*') && !hasId(id)) errors.push(`${f}: id "${id}" is not a testID in src/`);
      }
    }
  };
  visit(docs[1]);
}
const config = yaml.load(readFileSync(join(flowDir, 'config.yaml'), 'utf8'));
const order = config?.executionOrder?.flowsOrder ?? [];
for (const n of names) if (!order.includes(n)) errors.push(`flow "${n}" is not in config.yaml flowsOrder`);
for (const n of order) if (!names.includes(n)) errors.push(`config.yaml lists "${n}" but no flow has that name`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`${files.length} flow files OK (${names.length} flows, ${literalIds.size + templateIds.length} testIDs known)`);
