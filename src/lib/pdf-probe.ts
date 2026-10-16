// Dev-only on-device PDF probe (V1_PLAN P5 "Measure on both platforms"): renders the renderer's test documents
// with expo-print into Paths.document/pdf-probe/, measures them (pages in the file vs the renderer's plan, page
// size, bytes, time, embedded fonts, byte stability of two renders) and writes report.json with the strings and
// GiroCode payload each file must contain, for the independent Node re-parse (scripts/verify-pdfs.mjs).
// Reached only from Settings → Debug in development builds.
import { Directory, File, Paths } from 'expo-file-system';

import { formatMoney } from '@/engine/money';
import { TEMPLATE_IDS, renderHtml, buildCtx, type TemplateId } from '@/render/html';
import { giroPayload, subjectOf } from '@/render/html/shared';
import { type RenderModel } from '@/render/model';
import { stablePdfText } from '@/render/pdf-inspect';
import { printHtml } from '@/render/preview';
import { exampleModel, longInvoiceModel } from '@/render/test-models';
import { translate } from '@/i18n';

import { makePdf, type PdfResult } from './pdf';

export const PROBE_DIR = 'pdf-probe';
const LOGO = 'logo/probe-logo.png'; // pushed by the agent for the size check; the probe runs without it too

export type ProbeCase = { name: string; model: RenderModel; paper: 'A4' | 'LETTER'; template: TemplateId; logo: boolean; lines?: number; texts?: string[] };

const LONG_CLIENT = 'Bäckerei Müller-Lüdenscheidt & Söhne Großhandelsgesellschaft für Feinbackwaren und Süßwaren mbH & Co. KG';

function cases(): ProbeCase[] {
  const out: ProbeCase[] = [];
  for (const template of TEMPLATE_IDS) {
    out.push({ name: `A-${template}-A4`, model: exampleModel('A'), paper: 'A4', template, logo: true });
    out.push({ name: `long60-${template}-A4`, model: longInvoiceModel(60), paper: 'A4', template, logo: true, lines: 60 });
  }
  out.push({ name: 'A-classic-LETTER', model: exampleModel('A'), paper: 'LETTER', template: 'classic', logo: true });
  out.push({ name: 'long60-classic-LETTER', model: longInvoiceModel(60), paper: 'LETTER', template: 'classic', logo: true, lines: 60 });
  out.push({ name: 'long50-modern-A4', model: longInvoiceModel(50), paper: 'A4', template: 'modern', logo: false, lines: 50 });
  out.push({ name: 'one-line-classic-A4', model: longInvoiceModel(1, {}, false), paper: 'A4', template: 'classic', logo: false, lines: 1 });
  out.push({ name: 'D-en-classic-LETTER', model: exampleModel('D'), paper: 'LETTER', template: 'classic', logo: false });
  const umlaut = exampleModel(
    'A',
    { intro: 'Größere Änderungen für Straßenbau-Übergänge – „Qualitätsprüfung“ gemäß Maßgabe.' },
    { client: { name: LONG_CLIENT, street: 'Königsallee 123–125 (Hinterhof, Aufgang Süd)', city: 'Düsseldorf-Oberkassel' }, business: { name: 'Jürgen Weiß Gestaltung & Öffentlichkeitsarbeit' } }
  );
  out.push({ name: 'umlauts-classic-A4', model: umlaut, paper: 'A4', template: 'classic', logo: false });
  const intl = exampleModel('A', {}, { client: { name: '株式会社サンプル 東京本社', street: 'شارع الملك فهد ١٢', city: 'Ελληνικά Αθήνα' } });
  out.push({ name: 'cjk-arabic-classic-A4', model: intl, paper: 'A4', template: 'classic', logo: false });
  // §19 business whose document still carries VAT: the PDF shows the VAT rows (D51)
  out.push({ name: 's19-with-vat-classic-A4', model: exampleModel('A', {}, { business: { vatMode: 'small_business' } }), paper: 'A4', template: 'classic', logo: false });
  out.push({ name: 's19-classic-A4', model: exampleModel('C'), paper: 'A4', template: 'classic', logo: false });
  // non-EEA IBAN without BIC: bank lines print, no GiroCode (D57)
  const ch = exampleModel('A', {}, { business: { iban: 'CH9300762011623852957', bic: '', bankName: 'PostFinance' } });
  out.push({ name: 'ch-no-bic-classic-A4', model: ch, paper: 'A4', template: 'classic', logo: false, texts: ['CH9300762011623852957', 'PostFinance'] });
  // the tallest single row the check still accepts (~1 500 characters, the editor's cap) on its own page
  const tall = longInvoiceModel(3, {}, false);
  tall.lines[1] = { ...tall.lines[1], description: 'Lange Leistungsbeschreibung mit Umlauten (Größe, Übergabe, Maße) und Details. '.repeat(19).trim() };
  out.push({ name: 'tall-row-classic-A4', model: tall, paper: 'A4', template: 'classic', logo: false, lines: 3 });
  return out;
}

export type ProbeRow = {
  name: string;
  paper: string;
  template: string;
  expectedPages: number;
  pages: number;
  reportedPages: number;
  mediaBox: [number, number] | null;
  bytes: number;
  ms: number;
  msPerPage: number;
  fonts: string[];
  embeddedFonts: number;
  file: string;
  ok: boolean;
  problems: string[];
  /** Strings the PDF's text must contain (checked in Node with pdf.js). */
  expectTexts: string[];
  /** Lines "Position n:" that must appear exactly once each (long documents). */
  lines: number;
  giro: string | null;
  tooTall: boolean;
};

export type ProbeReport = {
  platform: string;
  createdAt: string;
  rows: ProbeRow[];
  stable: { file1: string; file2: string; identicalBytes: boolean; identicalNormalised: boolean };
  coldMs: number;
};

async function logoUri(): Promise<string | null> {
  const f = new File(Paths.document, LOGO);
  return f.exists ? `data:image/png;base64,${await f.base64()}` : null;
}

const SIZES = { A4: [595, 842], LETTER: [612, 792] } as const;

export async function runPdfProbe(platform: string, onProgress?: (text: string) => void): Promise<ProbeReport> {
  const dir = new Directory(Paths.document, PROBE_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const logo = await logoUri();
  const rows: ProbeRow[] = [];
  let coldMs = 0;
  const list = cases();
  for (const [i, c] of list.entries()) {
    onProgress?.(`${i + 1}/${list.length} ${c.name}`);
    const html = renderHtml(c.model, { paper: c.paper, template: c.template, logoDataUri: c.logo ? logo : null });
    const expectedPages = Number(/<body[^>]*data-pages="(\d+)"/.exec(html)?.[1] ?? 0);
    const file = new File(Paths.document, PROBE_DIR, `${c.name}.pdf`);
    const r: PdfResult = await makePdf(html, c.paper, file);
    if (i === 0) coldMs = r.ms;
    const ctx = buildCtx(c.model, { paper: c.paper, template: c.template });
    const lang = ctx.lang;
    const problems: string[] = [];
    const [w, h] = SIZES[c.paper];
    const box = r.info.mediaBoxes.find((b) => b[0] !== 0) ?? null;
    if (r.pages !== expectedPages) problems.push(`pages ${r.pages} ≠ planned ${expectedPages}`);
    if (!box || Math.abs(box[0] - w) > 1 || Math.abs(box[1] - h) > 1) problems.push(`MediaBox ${JSON.stringify(box)} ≠ ${w}×${h}`);
    if (r.info.mediaBoxes.some((b) => Math.abs(b[0] - box![0]) > 1 || Math.abs(b[1] - box![1]) > 1)) problems.push('mixed page sizes');
    const m = c.model;
    rows.push({
      name: c.name,
      paper: c.paper,
      template: c.template,
      expectedPages,
      pages: r.pages,
      reportedPages: r.reportedPages,
      mediaBox: box,
      bytes: r.bytes,
      ms: r.ms,
      msPerPage: Math.round(r.ms / Math.max(1, r.pages)),
      fonts: r.info.fonts,
      embeddedFonts: r.info.embeddedFonts,
      file: `${PROBE_DIR}/${c.name}.pdf`,
      ok: problems.length === 0,
      problems,
      expectTexts: [
        subjectOf(ctx),
        formatMoney(m.totals.gross, m.currency, lang),
        ...(m.client ? [m.client.name] : []),
        m.business.name,
        translate(lang, 'render.page', { n: expectedPages, m: expectedPages }),
        ...(html.includes('class="carry') ? [translate(lang, 'render.carry')] : []),
        ...(m.totals.tax !== 0 ? [formatMoney(m.totals.tax, m.currency, lang)] : []),
        ...(m.texts.legalNote.trim() ? [m.texts.legalNote.trim().split('\n')[0]] : []),
        ...(c.texts ?? []),
      ],
      lines: c.lines ?? 0,
      giro: giroPayload(m, m.totals.gross),
      tooTall: false,
    });
  }
  // byte stability: the first case once more
  onProgress?.('stability');
  const again = new File(Paths.document, PROBE_DIR, `${list[0].name}-again.pdf`);
  const first = list[0];
  await makePdf(renderHtml(first.model, { paper: first.paper, template: first.template, logoDataUri: first.logo ? logo : null }), first.paper, again);
  const a = await new File(Paths.document, PROBE_DIR, `${first.name}.pdf`).bytes();
  const b = await again.bytes();
  const identicalBytes = a.length === b.length && a.every((x, k) => x === b[k]);
  const report: ProbeReport = {
    platform,
    createdAt: new Date().toISOString(),
    rows,
    stable: { file1: `${PROBE_DIR}/${first.name}.pdf`, file2: `${PROBE_DIR}/${first.name}-again.pdf`, identicalBytes, identicalNormalised: stablePdfText(a) === stablePdfText(b) },
    coldMs,
  };
  new File(Paths.document, PROBE_DIR, 'report.json').write(JSON.stringify(report, null, 1));
  return report;
}

/** Print HTML of every probe case at zoom 1 (trimmed page boxes as printed), for the on-device layout measurement. */
export function probeHtmls(): { name: string; html: string }[] {
  return cases().map((c) => ({ name: c.name, html: printHtml(renderHtml(c.model, { paper: c.paper, template: c.template }), 1, c.paper) }));
}
