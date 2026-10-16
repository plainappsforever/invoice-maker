#!/usr/bin/env node
// Independent re-parse of the PDFs the on-device probe wrote (Settings → Debug → PDF probes, V1_PLAN P5):
// pdf.js reads every file — page count = the renderer's plan, page size, the text the document must contain
// (number, client, totals from the engine, "Seite n von m" on every page, "Übertrag", every line exactly once),
// the worked-example totals from src/engine/__fixtures__/worked-examples.json, the GiroCode decoded by macOS
// Core Image (scripts/inspect-pdf.swift) = the engine's payload, the DIN 5008 fold/punch marks at 105/148.5/210 mm
// and the right text edge at the 20 mm margin on Classic pages (1 renderer px = 1 pt), and byte stability.
//
// pdf.js is NOT a project dependency (pdf-lib/pdf.js are not on the v1 list): install it anywhere and pass its folder.
// Usage: node scripts/verify-pdfs.mjs --pdfjs <dir containing node_modules/pdfjs-dist> <pulled-probe-dir> [...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--pdfjs');
if (at < 0) {
  console.error('Usage: node scripts/verify-pdfs.mjs --pdfjs <dir> <probe-dir> [...]');
  process.exit(2);
}
const pdfjsDir = args[at + 1];
const dirs = args.filter((_, i) => i !== at && i !== at + 1);
const req = createRequire(path.join(path.resolve(pdfjsDir), 'index.js'));
const pdfjs = await import(pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const examples = JSON.parse(fs.readFileSync(path.join(root, 'src/engine/__fixtures__/worked-examples.json'), 'utf8')).examples;

const norm = (s) => s.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
const de = (cents) => `${(cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
const en = (cents) => `€${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
// Worked-example totals straight from the fixture (not from the app): case name prefix → [example, formatter]
const FIXTURE_CASES = { 'A-': ['A', de], 's19-classic': ['C', de], 'D-en': ['D', en] };

async function pagesText(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [x0, y0, x1, y1] = page.view;
    const content = await page.getTextContent();
    pages.push({ size: [Math.round((x1 - x0) * 10) / 10, Math.round((y1 - y0) * 10) / 10], text: norm(content.items.map((t) => t.str + (t.hasEOL ? ' ' : '')).join('')) });
  }
  return pages;
}

function swiftInspect(files) {
  const out = execFileSync('swift', [path.join(root, 'scripts/inspect-pdf.swift'), ...files], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    map.set(path.resolve(r.file), r);
  }
  return map;
}

const MM = 72 / 25.4;
// A4: DIN 5008 fold marks 105/210 mm, punch mark 148.5 mm; Letter: thirds of the page and the middle (P3 L11 row)
const MARKS = { A4: [105, 148.5, 210].map((v) => v * MM), LETTER: [264, 396, 528] };
// Known, accepted gaps (documented in V1_LOG P5): reported, not counted as failures.
const KNOWN = [
  { platform: 'ios', name: 'cjk-arabic-classic-A4', text: '株式会社サンプル 東京本社', why: 'iOS fallback font writes no text-layer entry for the katakana; the glyphs are drawn (checked on a rendered page)' },
];

let failures = 0;
for (const dir of dirs) {
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const fileOf = (rel) => path.resolve(dir, path.basename(rel));
  const swift = swiftInspect(report.rows.map((r) => fileOf(r.file)));
  console.log(`\n== ${report.platform} (${dir}) — ${report.rows.length} files`);
  for (const row of report.rows) {
    const problems = [];
    const pages = await pagesText(fileOf(row.file));
    const all = pages.map((p) => p.text).join(' ');
    if (pages.length !== row.expectedPages) problems.push(`pdf.js pages ${pages.length} ≠ planned ${row.expectedPages}`);
    const want = row.paper === 'A4' ? [595, 842] : [612, 792];
    for (const [i, p] of pages.entries()) if (Math.abs(p.size[0] - want[0]) > 1 || Math.abs(p.size[1] - want[1]) > 1) problems.push(`page ${i + 1} size ${p.size.join('×')}`);
    const notes = [];
    for (const t of row.expectTexts) {
      if (all.includes(norm(t))) continue;
      const known = KNOWN.find((k) => k.platform === report.platform && k.name === row.name && k.text === t);
      if (known) notes.push(`known: "${t}" not in the text layer — ${known.why}`);
      else problems.push(`missing text "${t}"`);
    }
    const pageWord = row.expectTexts.find((t) => /^(Seite|Page) \d+ (von|of) \d+$/.test(t));
    if (pageWord) {
      const [w1, , w3] = pageWord.split(' ');
      for (const [i, p] of pages.entries()) if (!p.text.includes(`${w1} ${i + 1} ${w3} ${pages.length}`)) problems.push(`page ${i + 1} lacks "${w1} ${i + 1} ${w3} ${pages.length}"`);
    }
    for (let n = 1; n <= row.lines; n++) {
      const count = all.split(`Position ${n}:`).length - 1;
      if (count !== 1) problems.push(`line ${n} appears ${count}×`);
    }
    for (const [prefix, [id, fmt]] of Object.entries(FIXTURE_CASES)) {
      if (!row.name.startsWith(prefix)) continue;
      const exp = examples.find((e) => e.id === id).expected;
      if (!all.includes(fmt(exp.gross))) problems.push(`fixture ${id} gross ${fmt(exp.gross)} missing`);
      if (exp.tax !== 0 && !all.includes(fmt(exp.tax))) problems.push(`fixture ${id} VAT ${fmt(exp.tax)} missing`);
    }
    if (row.name.startsWith('s19-with-vat') && !/USt|VAT/.test(all)) problems.push('VAT row missing under §19 with VAT (D51)');
    if (row.name === 's19-classic-A4' && !all.includes('§ 19')) problems.push('§19 note missing');
    const geo = swift.get(fileOf(row.file)) ?? { codes: [], marks: [], inkRight: 0 };
    const codes = geo.codes;
    if (row.template === 'classic') {
      for (const want of MARKS[row.paper]) if (!geo.marks.some((y) => Math.abs(y - want) <= 1.5)) problems.push(`mark at ${want.toFixed(1)} pt missing (found ${geo.marks.join(', ')})`);
      const right = (row.paper === 'A4' ? 595 : 612) - 20 * MM;
      if (Math.abs(geo.inkRight - right) > 6) problems.push(`right ink edge ${geo.inkRight} pt ≠ ${right.toFixed(1)} (scale)`);
    }
    if (row.giro) {
      if (!codes.some((c) => c.text === row.giro)) problems.push(`GiroCode not decoded/equal (${codes.length} codes)`);
    } else if (codes.length) problems.push('unexpected QR code');
    if (problems.length) failures++;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${row.name.padEnd(26)} pages ${pages.length} ${pages[0]?.size.join('×')} ${Math.round(row.bytes / 1024)} KB ${row.ms} ms${row.giro ? ' QR=engine' : ''}${row.template === 'classic' ? ` marks ${geo.marks.join('/')} right ${geo.inkRight}` : ''}${problems.length ? ' — ' + problems.join('; ') : ''}`);
    for (const n of notes) console.log(`     ${n}`);
  }
  const a = fs.readFileSync(fileOf(report.stable.file1));
  const b = fs.readFileSync(fileOf(report.stable.file2));
  const strip = (buf) => buf.toString('latin1').replace(/\/(CreationDate|ModDate)\s*\([^)]*\)/g, '').replace(/\/ID\s*\[[^\]]*\]/g, '').replace(/\/[A-Z]{6}\+/g, '/');
  console.log(`stability: bytes ${a.equals(b) ? 'identical' : 'differ'}; without dates/ID/subset tags ${strip(a) === strip(b) ? 'identical' : 'DIFFER'}`);
  const ta = (await pagesText(fileOf(report.stable.file1))).map((p) => p.text).join('|');
  const tb = (await pagesText(fileOf(report.stable.file2))).map((p) => p.text).join('|');
  console.log(`stability: extracted text ${ta === tb ? 'identical' : 'DIFFERS'}`);
}
console.log(failures ? `\n${failures} file(s) with problems` : '\nall files ok');
process.exit(failures ? 1 : 0);
