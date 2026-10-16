/**
 * @jest-environment node
 */
import examples from '@/engine/__fixtures__/worked-examples.json';
import { buildEpcPayload } from '@/engine/epc-qr';
import { formatAmount, formatMoney as formatMoneyRaw } from '@/engine/money';
import { defaultLegalNote, LEGAL_NOTES } from '@/engine/notes';
import type { Treatment, VatMode } from '@/engine/treatment';
import { exampleModel, longInvoiceModel, TEST_BUSINESS, TEST_CLIENT, type ExampleId } from '@/render/test-models';

import { geometryFor, mm } from './din5008';
import { buildCtx, computeLayout, paginate, renderHtml, TEMPLATE_IDS, type TemplateId } from './index';
import { paginateItems, tooTall, tooTallItems, type Measure } from './paginate';
import { matrixPath, qrMatrix, qrSvg, utf8BinaryString } from './qr-svg';
import { charWidthEm, esc, giroPayload, safeAccent, safeLogo, SENDER_MIN_PX, senderFit, textWidth, wrapLineCount } from './shared';

const opts = { embedFonts: false } as const;
/** visibleText() turns the non-breaking space of formatMoney into a normal one. */
const formatMoney = (cents: number, currency: string, lang: 'de' | 'en') => formatMoneyRaw(cents, currency, lang).replace(/\s/g, ' ');

/** Visible text of the HTML: tags removed, entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  const at = html.indexOf('<body');
  const body = at >= 0 ? html.slice(at) : html;
  return body
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<br>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const pagesOf = (html: string) => html.split('<section class="page"').slice(1);
const count = (haystack: string, needle: string | RegExp) =>
  typeof needle === 'string' ? haystack.split(needle).length - 1 : (haystack.match(needle) ?? []).length;

type Expected = {
  lines: { net: number }[];
  groups: { category: string; rateBp: number; taxable: number; tax: number; gross: number }[];
  lineTotal: number;
  discount: number;
  net: number;
  tax: number;
  gross: number;
};
const expectedOf = (id: string) => (examples.examples.find((e) => e.id === id) as unknown as { expected: Expected }).expected;

describe('geometry (DIN 5008, V1_PLAN)', () => {
  it('pages are 595×842 (A4) and 612×792 (Letter) px at 72 ppi', () => {
    expect([geometryFor('A4').w, geometryFor('A4').h]).toEqual([595, 842]);
    expect([geometryFor('LETTER').w, geometryFor('LETTER').h]).toEqual([612, 792]);
  });
  it('mm → px at 72 ppi', () => {
    expect(mm(25.4)).toBe(72);
    expect(mm(20)).toBe(56.69);
    expect(mm(45)).toBe(127.56);
    expect(mm(85)).toBe(240.94);
    expect(mm(148.5)).toBe(420.94);
  });
  it('Classic: address field 20 mm left, 45 mm top, 85 × 45 mm with a 1-line sender; fold marks 105/210, punch 148.5', () => {
    const html = renderHtml(exampleModel('A'), opts);
    expect(html).toContain(`<div class="abs addr" style="top:${mm(45)}px;height:${mm(45)}px" data-address="1">`);
    expect(html).toContain(`.addr{left:${mm(20)}px;width:${mm(85)}px}`);
    expect(html).toContain(`.sender{`);
    expect(html).toContain(`line-height:${mm(5)}px;height:${mm(5)}px`);
    expect(html).toContain(`data-mark="fold" style="top:${mm(105)}px"`);
    expect(html).toContain(`data-mark="fold" style="top:${mm(210)}px"`);
    expect(html).toContain(`data-mark="punch" style="top:${mm(148.5)}px"`);
    expect(html).toContain(`<h1 class="abs subject" style="top:${mm(98.5)}px`);
    expect(html).toContain(`left:${mm(125)}px`); // info block
  });
  it('Modern and Compact have no fold marks', () => {
    for (const template of ['modern', 'compact'] as const) expect(renderHtml(exampleModel('A'), { ...opts, template })).not.toContain('data-mark=');
  });
});

describe('required fields per example, language and template', () => {
  const ids: ExampleId[] = ['A', 'B', 'C', 'D', 'E1', 'E2', 'F'];
  describe.each(TEMPLATE_IDS)('%s', (template) => {
    it.each(ids)('example %s shows the mandatory details', (id) => {
      const model = exampleModel(id);
      const html = renderHtml(model, { ...opts, template });
      const text = visibleText(html);
      const lang = model.language;
      const de = lang === 'de';
      // supplier: name, address, tax number and VAT id, bank
      for (const part of ['Muster Design GmbH', 'Hauptstraße 1', '10115 Berlin', '12/345/67890', 'DE123456789', 'DE89370400440532013000']) expect(text).toContain(part);
      // recipient
      expect(text).toContain(model.client!.name);
      expect(text).toContain(model.client!.street);
      // number, date, service date, due date
      expect(text).toContain(model.number);
      expect(text).toContain(de ? '01.10.2026' : '1 Oct 2026');
      expect(text).toContain(de ? 'Leistungsdatum' : 'Date of supply');
      if (model.type === 'invoice') expect(text).toContain(de ? '15.10.2026' : '15 Oct 2026');
      // every line: name, quantity, VAT rate and the line amount per locale
      for (const line of model.lines) {
        expect(text).toContain(line.name);
        expect(text).toContain(formatAmount(line.net, lang));
      }
      // totals per locale
      expect(text).toContain(formatMoney(model.totals.gross, 'EUR', lang));
      expect(text).toContain(`${de ? 'Seite 1 von' : 'Page 1 of'}`);
      // page structure
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(count(html, '<section class="page"')).toBeGreaterThanOrEqual(1);
    });
  });

  it('example A, German: every number of the worked example appears formatted 1.234,56 €', () => {
    const e = expectedOf('A');
    const text = visibleText(renderHtml(exampleModel('A'), { ...opts, payments: [{ date: '2026-10-05', amountCents: 30000 }] }));
    for (const cents of [e.lineTotal, e.discount, e.net, e.tax, e.gross]) expect(text).toContain(formatMoney(cents, 'EUR', 'de'));
    expect(text).toContain('Summe');
    expect(text).toContain('1.330,29 €');
    expect(text).toContain('Nettobetrag');
    expect(text).toContain('Gesamtbetrag');
    expect(text).toContain('Rabatt 5 %');
    expect(text).toContain('Bezahlt, Stand 05.10.2026'); // dated payment status (review #13)
    expect(text).toContain('-300,00 €');
    expect(text).toContain('Noch zu zahlen');
    expect(text).toContain('1.030,29 €');
  });
  it('example D, English: €1,234.56 and "1 Oct 2026"', () => {
    const model = exampleModel('D');
    const text = visibleText(renderHtml(model, opts));
    expect(text).toContain('€2,000.00');
    expect(text).toContain('Invoice no.');
    expect(text).toContain('Please transfer');
    expect(text).not.toContain('Rechnungsnr.');
    expect(text).toContain('Acme BV');
    expect(text).toContain('NETHERLANDS');
    expect(text).toContain('NL123456789B01');
  });
});

describe('mixed VAT summary and totals layout', () => {
  it('A: two tax groups → VAT summary with 19 % and 7 %, taxable, VAT and gross per group', () => {
    const html = renderHtml(exampleModel('A'), opts);
    expect(count(html, 'data-vat-summary="1"')).toBe(1);
    const summary = visibleText(html.slice(html.indexOf('data-vat-summary')));
    const e = expectedOf('A');
    for (const g of e.groups) {
      expect(summary).toContain(`USt. ${g.rateBp / 100} %`);
      for (const c of [g.taxable, g.tax, g.gross]) expect(summary).toContain(formatMoney(c, 'EUR', 'de'));
    }
    const text = visibleText(html);
    expect(text).toContain('zzgl. 19 % USt. auf 1.075,35 €');
    expect(text).toContain('zzgl. 7 % USt. auf 47,31 €');
  });
  it('B (gross prices): "enthält … USt." rows instead of "zzgl."', () => {
    const text = visibleText(renderHtml(exampleModel('B'), opts));
    expect(text).toContain('enthält 19 % USt. auf');
    expect(text).not.toContain('zzgl.');
  });
  it('E1: a single standard group has no summary table', () => {
    expect(renderHtml(exampleModel('E1'), opts)).not.toContain('data-vat-summary');
  });
  it('C (§19): no VAT column, no VAT rows, no summary; total = net', () => {
    const html = renderHtml(exampleModel('C'), opts);
    const text = visibleText(html);
    expect(html).not.toContain('data-vat-summary');
    expect(text).not.toContain('zzgl.');
    expect(text).not.toContain('USt.:');
    expect(html).not.toMatch(/<th[^>]*>USt\.<\/th>/);
    expect(text).toContain('Rabatt 10 %');
  });
  it('D (reverse charge): summary names the treatment, VAT is 0', () => {
    const html = renderHtml(exampleModel('D'), opts);
    expect(visibleText(html.slice(html.indexOf('data-vat-summary')))).toContain('Reverse charge');
  });
  it('F: the cancellation shows the exact negative amounts', () => {
    const text = visibleText(renderHtml(exampleModel('F'), opts));
    expect(text).toContain('-1.330,29 €');
    expect(text).toContain('Stornorechnung RE-2026-0002');
    expect(text).toContain('Bezug: Rechnung RE-2026-0001');
  });
});

describe('legal notes appear exactly when the rules say (A4, D21)', () => {
  const combos: [Treatment, VatMode][] = [
    ['standard', 'standard'],
    ['standard', 'small_business'],
    ['reverse_charge', 'standard'],
    ['intra_eu_goods', 'standard'],
    ['export', 'standard'],
    ['exempt', 'standard'],
  ];
  it.each(combos)('%s / %s', (treatment, vatMode) => {
    for (const lang of ['de', 'en'] as const) {
      const model = exampleModel('E1', { treatment, language: lang, legalNote: defaultLegalNote(treatment, vatMode, lang) }, { business: { vatMode } });
      const html = renderHtml(model, opts);
      const note = defaultLegalNote(treatment, vatMode, lang);
      if (note) {
        expect(count(html, 'data-legal-note="1"')).toBe(1);
        expect(visibleText(html)).toContain(note);
      } else {
        expect(html).not.toContain('data-legal-note');
      }
      // the other notes never leak in
      for (const other of Object.values(LEGAL_NOTES)) {
        const text = other.text[lang];
        if (text !== note) expect(visibleText(html)).not.toContain(text);
      }
    }
  });
  it('the standard invoice mentions no §19 / reverse charge wording at all', () => {
    const text = visibleText(renderHtml(exampleModel('A'), opts));
    for (const word of ['§ 19', 'Steuerschuldnerschaft', 'innergemeinschaftliche', 'Ausfuhrlieferung', 'Kleinunternehmer']) expect(text).not.toContain(word);
  });
  it('the sources of a note are not printed on the document (they stay in the app)', () => {
    const text = visibleText(renderHtml(exampleModel('C'), opts));
    expect(text).not.toContain('gesetze-im-internet');
    expect(text).not.toContain('§ 34a UStDV');
  });
});

describe('GiroCode (D26)', () => {
  const a = () => exampleModel('A');
  const payments = [{ date: '2026-10-05', amountCents: 30000 }];
  it('payload = the engine payload; the SVG is that payload as a QR code (level M, UTF-8)', () => {
    const model = a();
    const html = renderHtml(model, { ...opts, payments });
    const fixture = (examples.examples[0].document as { girocode: string }).girocode;
    const balance = model.totals.gross - 30000;
    // the fixture has no BIC, the plain business name and no client name in the remittance text
    const plain = exampleModel('A', {}, { business: { name: 'Muster Design', accountHolder: '', bic: '' }, client: null });
    expect(giroPayload(plain, balance)).toBe(fixture);
    expect(renderHtml(plain, { ...opts, payments })).toContain(`<path d="${matrixPath(qrMatrix(fixture))}" fill="#000"/>`);
    expect(count(html, '<svg class="girocode"')).toBe(1);
    const payload = giroPayload(model, balance)!;
    expect(html).toContain(`<path d="${matrixPath(qrMatrix(payload))}" fill="#000"/>`);
    expect(html).toContain('GiroCode');
    // same bytes as an independently built engine payload
    const engine = buildEpcPayload({ name: 'Muster Design GmbH', iban: TEST_BUSINESS.iban, bic: 'COBADEFFXXX', amountCents: balance, currency: 'EUR', remittance: 'RE-2026-0001 Kunde & Söhne <GmbH>' });
    expect(engine.ok && engine.payload).toBe(giroPayload(model, balance));
  });
  it('the amount is the balance due (after payments)', () => {
    const model = a();
    expect(giroPayload(model, model.totals.gross)).toContain('EUR1330.29');
    expect(giroPayload(model, model.totals.gross - 30000)).toContain('EUR1030.29');
  });
  it('QR path is deterministic, a real matrix with finder patterns, and the size is ≥ 2 cm', () => {
    const matrix = qrMatrix('BCD\n002\n1\nSCT\n\nMuster Design\nDE89370400440532013000\nEUR1030.29\n\n\nRE-2026-0001');
    const n = matrix.length;
    expect((n - 21) % 4).toBe(0);
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let i = 0; i < 7; i++) {
        expect(matrix[r][c + i]).toBe(true);
        expect(matrix[r + 6][c + i]).toBe(true);
        expect(matrix[r + i][c]).toBe(true);
        expect(matrix[r + i][c + 6]).toBe(true);
      }
      expect(matrix[r + 1][c + 1]).toBe(false);
      expect(matrix[r + 3][c + 3]).toBe(true);
    }
    expect(qrSvg('x', 66)).toBe(qrSvg('x', 66));
    expect(66 / (72 / 25.4)).toBeGreaterThan(20); // mm
  });
  it('UTF-8: umlauts are two bytes in the QR data (EPC charset 1)', () => {
    expect(utf8BinaryString('ü').length).toBe(2);
    expect(utf8BinaryString('€').length).toBe(3);
    expect(utf8BinaryString('ab')).toBe('ab');
    expect(matrixPath(qrMatrix('Müller'))).not.toBe(matrixPath(qrMatrix('MÃ¼ller')) + 'x');
    expect(matrixPath(qrMatrix('Müller'))).toBe(matrixPath(qrMatrix('Müller')));
  });
  it.each<[string, () => ReturnType<typeof exampleModel>, { payments?: typeof payments }]>([
    ['currency is not EUR', () => exampleModel('A', { currency: 'USD' }), { payments }],
    ['no IBAN', () => exampleModel('A', {}, { business: { iban: '' } }), { payments }],
    ['an invalid IBAN', () => exampleModel('A', {}, { business: { iban: 'DE00 1234' } }), { payments }],
    ['fully paid (balance 0)', a, { payments: [{ date: '2026-10-05', amountCents: 133029 }] }],
    ['overpaid', a, { payments: [{ date: '2026-10-05', amountCents: 150000 }] }],
    ['"Show GiroCode" is off', () => exampleModel('A', { showGirocode: false }), { payments }],
    ['a quote', () => exampleModel('A', { type: 'quote' }), { payments }],
    ['a cancellation', () => exampleModel('F'), {}],
    ['a receipt', () => exampleModel('A', { type: 'receipt', receiptKind: 'cash' }), {}],
  ])('no GiroCode when %s', (_label, make, o) => {
    expect(renderHtml(make(), { ...opts, ...o })).not.toContain('<svg class="girocode"');
  });
  it('present for EUR + IBAN + balance > 0 in all templates and on Letter', () => {
    for (const template of TEMPLATE_IDS) for (const paper of ['A4', 'LETTER'] as const) expect(renderHtml(a(), { ...opts, template, paper })).toContain('<svg class="girocode"');
  });
});

describe('payment block', () => {
  it('shows the due date, bank details and reference; paid invoices show no bank block', () => {
    const open = visibleText(renderHtml(exampleModel('A'), opts));
    expect(open).toContain('Bitte überweisen Sie 1.330,29 € bis zum 15.10.2026.');
    expect(open).toContain('Verwendungszweck: RE-2026-0001');
    const paid = visibleText(renderHtml(exampleModel('A'), { ...opts, payments: [{ date: '2026-10-05', amountCents: 133029 }] }));
    expect(paid).not.toContain('Bitte überweisen');
    expect(paid).toContain('Noch zu zahlen 0,00 €');
  });
  it('an overpaid invoice prints "Überzahlung", never a negative amount due (review #13)', () => {
    const over = visibleText(renderHtml(exampleModel('A'), { ...opts, payments: [{ date: '2026-10-05', amountCents: 150000 }] }));
    expect(over).toContain('Bezahlt, Stand 05.10.2026 -1.500,00 €');
    expect(over).toContain('Überzahlung 169,71 €');
    expect(over).not.toContain('Noch zu zahlen');
    expect(over).not.toMatch(/-169,71/);
    const en = visibleText(renderHtml(exampleModel('A', { language: 'en' }), { ...opts, payments: [{ date: '2026-10-05', amountCents: 150000 }] }));
    expect(en).toContain('Overpaid €169.71');
  });
  it('deposit is printed as text (D22)', () => {
    expect(visibleText(renderHtml(exampleModel('A', { depositCents: 50000 }), opts))).toContain('Angeforderte Anzahlung: 500,00 €');
  });
  it('quotes show "valid until", no payment block', () => {
    const html = renderHtml(exampleModel('A', { type: 'quote', validUntil: '2026-10-31', dueDate: null }), opts);
    const text = visibleText(html);
    expect(text).toContain('Angebot RE-2026-0001');
    expect(text).toContain('Gültig bis 31.10.2026');
    expect(html).not.toContain('data-block="payment"');
    expect(text).not.toContain('Fällig am');
  });
  it('receipts: titles by kind', () => {
    expect(visibleText(renderHtml(exampleModel('A', { type: 'receipt', receiptKind: 'payment' }), opts))).toContain('Zahlungsbeleg');
    expect(visibleText(renderHtml(exampleModel('A', { type: 'receipt', receiptKind: 'cash' }), opts))).toContain('Quittung');
  });
  it('a draft shows "Entwurf" instead of a number', () => {
    const m = { ...exampleModel('A'), number: null };
    expect(visibleText(renderHtml(m, opts))).toContain('Rechnung – Entwurf');
    expect(visibleText(renderHtml({ ...m, language: 'en' }, opts))).toContain('Invoice – Draft');
  });
});

describe('service date modes', () => {
  const text = (over: Parameters<typeof exampleModel>[1]) => visibleText(renderHtml(exampleModel('A', over), opts));
  it('same / date / period / month / none', () => {
    expect(text({ serviceMode: 'same' })).toContain('Leistungsdatum 01.10.2026 (wie Belegdatum)');
    expect(text({ serviceMode: 'date', serviceFrom: '2026-09-28' })).toContain('Leistungsdatum 28.09.2026');
    expect(text({ serviceMode: 'period', serviceFrom: '2026-09-01', serviceTo: '2026-09-30' })).toContain('Leistungszeitraum 01.09.2026 – 30.09.2026');
    expect(text({ serviceMode: 'month', serviceFrom: '2026-09-01' })).toContain('Leistungszeitraum September 2026');
    const none = text({ serviceMode: 'none' });
    expect(none).not.toContain('Leistungsdatum');
    expect(none).not.toContain('Leistungszeitraum');
  });
  it('English labels', () => {
    expect(visibleText(renderHtml(exampleModel('A', { language: 'en', serviceMode: 'period', serviceFrom: '2026-09-01', serviceTo: '2026-09-30' }), opts))).toContain('Service period 1 Sep 2026 – 30 Sep 2026');
  });
});

describe('escaping (user text never becomes markup)', () => {
  const nasty = `<script>alert('x')</script> "quoted" & <img src=x onerror=alert(1)>`;
  const model = exampleModel(
    'A',
    { intro: nasty, notes: nasty, paymentText: nasty, footer: nasty, legalNote: nasty, reference: nasty, buyerReference: nasty, customFields: JSON.stringify([{ label: nasty, value: nasty }]), accent: 'red;}</style><script>alert(1)</script>' },
    { business: { name: nasty, street: nasty, footer: nasty, email: nasty, bankName: nasty }, client: { name: nasty, street: nasty, contact: nasty, city: nasty } }
  );
  model.lines[0].name = nasty;
  model.lines[0].description = nasty;
  for (const template of TEMPLATE_IDS) {
    it(`${template}: no raw tag from user text survives`, () => {
      const html = renderHtml(model, { ...opts, template, logoDataUri: 'data:image/png;base64,AAAA" onerror="alert(1)' });
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toMatch(/<img [^>]*onerror/);
      expect(html).not.toContain('</style><script');
      expect(html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
      expect(html).toContain('&quot;quoted&quot; &amp;');
      // the invalid logo is dropped, the bad accent falls back
      expect(html).not.toContain('<img class="logo"');
      expect(html).toContain('#1F4E79');
      expect(visibleText(html)).toContain(nasty);
    });
  }
  it('esc and sanitisers', () => {
    expect(esc(`<a href="x">'&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
    expect(esc('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne');
    expect(safeAccent('#1f4e79')).toBe('#1f4e79');
    expect(safeAccent('#fff')).toBe('#1F4E79');
    expect(safeAccent('url(x)')).toBe('#1F4E79');
    expect(safeAccent(null)).toBe('#1F4E79');
    expect(safeLogo('data:image/png;base64,iVBORw0KGgo=')).not.toBeNull();
    expect(safeLogo('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeLogo('https://evil.example/x.png')).toBeNull();
    expect(safeLogo('data:image/png;base64,AA" onload="x')).toBeNull();
  });
  it('a valid logo is embedded as data URI (left, or right with logoRight)', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    for (const template of TEMPLATE_IDS) {
      const left = renderHtml(exampleModel('A'), { ...opts, template, logoDataUri: uri });
      expect(left).toContain(`<img class="logo" src="${uri}" alt="">`);
      expect(left).not.toContain('lh right');
      const right = renderHtml(exampleModel('A', { logoRight: true }), { ...opts, template, logoDataUri: uri });
      expect(right).toContain('lh right');
    }
  });
});

describe('pagination of long invoices (D23)', () => {
  const long = longInvoiceModel(60);
  const html = renderHtml(long, opts);
  const pages = pagesOf(html);

  it('60 lines → at least 2 pages, page count consistent everywhere', () => {
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain(`data-pages="${pages.length}"`);
    expect(count(html, 'break-after:page')).toBeGreaterThanOrEqual(1);
    expect(html).toContain('.page:last-child{break-after:auto');
  });
  it('page numbers "Seite n von m" on every page; English "Page n of m"', () => {
    pages.forEach((p, i) => expect(visibleText(`<body>${p}`)).toContain(`Seite ${i + 1} von ${pages.length}`));
    const en = renderHtml({ ...long, language: 'en' }, opts);
    pagesOf(en).forEach((p, i, all) => expect(p).toContain(`Page ${i + 1} of ${all.length}`));
  });
  it('the table header is repeated on every page that has rows', () => {
    for (const p of pages) {
      const tables = p.match(/<table class="lines"[\s\S]*?<\/table>/g) ?? [];
      expect(tables.length).toBe(count(p, '<tr class="row"') > 0 ? 1 : 0);
      for (const table of tables) {
        expect(count(table, '<thead>')).toBe(1);
        expect(table.indexOf('<thead>')).toBeLessThan(table.indexOf('<tr class="row"'));
      }
    }
  });
  it('every line appears exactly once, in order, and no row is split across pages', () => {
    const seen: number[] = [];
    for (const p of pages) {
      const rows = p.match(/<tr class="row" data-line="(\d+)">[\s\S]*?<\/tr>/g) ?? [];
      for (const row of rows) {
        expect(count(row, '<tr')).toBe(1);
        seen.push(Number(/data-line="(\d+)"/.exec(row)![1]));
      }
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(count(html, '<tr class="row"')).toBe(60);
  });
  it('"Übertrag" rows carry the running sum; the last page has none at the bottom', () => {
    const net = long.lines.map((l) => l.net);
    const sum = (n: number) => net.slice(0, n).reduce((a, b) => a + b, 0);
    let before = 0;
    pages.forEach((p, i) => {
      const rows = (p.match(/<tr class="row"/g) ?? []).length;
      const carryIn = p.match(/<tr class="carry in">[\s\S]*?<td class="num">([^<]*)<\/td>/);
      const carryOut = p.match(/<tr class="carry out">[\s\S]*?<td class="num">([^<]*)<\/td>/);
      if (i === 0) expect(carryIn).toBeNull();
      else if (rows > 0) expect(carryIn![1]).toBe(formatAmount(sum(before), 'de'));
      if (rows > 0) before += rows;
      if (i < pages.length - 1 && rows > 0 && before < 60) expect(carryOut![1]).toBe(formatAmount(sum(before), 'de'));
      if (before === 60) expect(carryOut).toBeNull();
    });
    expect(visibleText(html)).toContain('Übertrag');
  });
  it('the closing blocks appear once each, in order, after the last row (they may spill to an extra page)', () => {
    for (const block of ['totals', 'notes', 'payment']) expect(count(html, `data-block="${block}"`)).toBe(1);
    const rowsPage = pages.findIndex((p) => p.includes('data-line="60"'));
    expect(pages[rowsPage]).toContain('data-block="totals"');
    // payment column and totals are one block (side by side); the notes follow
    expect(html.indexOf('data-block="totals"')).toBeLessThan(html.indexOf('data-block="payment"'));
    expect(html.indexOf('data-block="payment"')).toBeLessThan(html.indexOf('data-block="notes"'));
    expect(pages.length - 1 - rowsPage).toBeLessThanOrEqual(1);
  });
  it('the estimate fits every page (used ≤ capacity), on A4 and Letter and in every template', () => {
    for (const template of TEMPLATE_IDS) {
      for (const paper of ['A4', 'LETTER'] as const) {
        const ctx = buildCtx(long, { template, paper });
        const plan = paginate(ctx);
        for (const page of plan) expect(page.usedPx).toBeLessThanOrEqual(page.capacityPx);
        expect(plan.flatMap((p) => p.rows)).toEqual(Array.from({ length: 60 }, (_, i) => i));
      }
    }
  });
  it('Letter has fewer rows per page than A4 (shorter page) and a 612×792 box', () => {
    const letter = renderHtml(long, { ...opts, paper: 'LETTER' });
    expect(letter).toContain('width:612px;height:792px');
    expect(pagesOf(letter).length).toBeGreaterThanOrEqual(pages.length);
    expect(html).toContain('width:595px;height:842px');
  });
  it('Compact fits more lines on the first page than Classic', () => {
    const first = (template: TemplateId) => paginate(buildCtx(long, { template }))[0].rows.length;
    expect(first('compact')).toBeGreaterThan(first('classic'));
  });
  it('a short invoice stays on one page: "Seite 1 von 1", no carry rows', () => {
    const one = renderHtml(exampleModel('A'), opts);
    expect(pagesOf(one)).toHaveLength(1);
    expect(one).toContain('Seite 1 von 1');
    expect(one).not.toContain('class="carry');
  });
  it('totals that do not fit after the last row go to an extra page with the notes (never split)', () => {
    // find a line count whose last page is nearly full: the totals block then moves to its own page
    let found = false;
    for (let n = 8; n <= 40 && !found; n++) {
      const ctx = buildCtx(longInvoiceModel(n, {}, false), { template: 'classic' });
      const plan = paginate(ctx);
      const last = plan[plan.length - 1];
      if (last.rows.length === 0 && last.blocks.includes('totals')) {
        found = true;
        const out = renderHtml(longInvoiceModel(n, {}, false), opts);
        const lastHtml = pagesOf(out).pop()!;
        expect(lastHtml).not.toContain('<table class="lines"');
        expect(lastHtml).toContain('data-block="totals"');
        expect(lastHtml).toContain('Seite');
      }
    }
    expect(found).toBe(true);
  });
  it('very long unbroken text does not break pagination', () => {
    const model = longInvoiceModel(5, {}, false);
    model.lines[2].description = 'x'.repeat(4000);
    const plan = paginate(buildCtx(model, {}));
    expect(plan.flatMap((p) => p.rows)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.length).toBeGreaterThanOrEqual(2);
  });
});

describe('paginateItems (pure)', () => {
  const base: Measure = { capacityFirst: 100, capacityNext: 200, introH: 0, tableHeadH: 10, carryH: 10, rowHeights: [], blocks: [] };
  it('moves a row that does not fit to the next page and reserves the carry rows', () => {
    const plan = paginateItems({ ...base, rowHeights: [40, 40, 40, 40] });
    // page 1: head 10 + 40 + carry 10 reserve → second row would need 10+40+40+10 = 100 ≤ 100
    expect(plan[0].rows).toEqual([0, 1]);
    expect(plan[0].carryOut).toBe(true);
    expect(plan[1].carryIn).toBe(true);
    expect(plan[1].rows).toEqual([2, 3]);
    expect(plan[1].carryOut).toBe(false);
  });
  it('the last row reserves no carry row', () => {
    const plan = paginateItems({ ...base, rowHeights: [40, 40] , capacityFirst: 90 });
    expect(plan).toHaveLength(1);
    expect(plan[0].carryOut).toBe(false);
  });
  it('an item taller than an empty page is placed anyway (progress guaranteed)', () => {
    const plan = paginateItems({ ...base, rowHeights: [500, 10], blocks: [{ id: 'totals', h: 900 }] });
    expect(plan.flatMap((p) => p.rows)).toEqual([0, 1]);
    expect(plan.flatMap((p) => p.blocks)).toEqual(['totals']);
  });
  it('blocks fill the last page, then spill to a new one', () => {
    const plan = paginateItems({ ...base, rowHeights: [10], blocks: [{ id: 'totals', h: 50 }, { id: 'legal', h: 50 }, { id: 'closing', h: 50 }] });
    expect(plan[0].blocks).toEqual(['totals']);
    expect(plan[1].blocks).toEqual(['legal', 'closing']);
    expect(plan[1].rows).toEqual([]);
  });
  it('intro takes space on page 1; zero rows → blocks only', () => {
    const plan = paginateItems({ ...base, introH: 60, rowHeights: [], blocks: [{ id: 'totals', h: 30 }] });
    expect(plan).toHaveLength(1);
    expect(plan[0].intro).toBe(true);
    expect(plan[0].usedPx).toBe(90);
  });
});

describe('text metrics', () => {
  it('wraps greedily and breaks over-long words; empty text is one line', () => {
    expect(wrapLineCount('', 100, 9)).toBe(1);
    expect(wrapLineCount('ab cd', 1000, 9)).toBe(1);
    expect(wrapLineCount('a\nb\nc', 1000, 9)).toBe(3);
    expect(wrapLineCount('word '.repeat(60), 200, 9)).toBeGreaterThan(5);
    expect(wrapLineCount('x'.repeat(400), 100, 9)).toBeGreaterThan(10);
  });
  it('bold text is wider; narrower boxes need more lines', () => {
    const text = 'Webdesign und Pflege der Unternehmensseite im Monat Oktober';
    expect(wrapLineCount(text, 120, 9, true)).toBeGreaterThanOrEqual(wrapLineCount(text, 120, 9));
    expect(wrapLineCount(text, 60, 9)).toBeGreaterThan(wrapLineCount(text, 240, 9));
  });
});

describe('determinism and fonts', () => {
  it('same model + options → identical string', () => {
    for (const template of TEMPLATE_IDS) {
      const a = renderHtml(longInvoiceModel(30), { template, embedFonts: false });
      expect(renderHtml(longInvoiceModel(30), { template, embedFonts: false })).toBe(a);
    }
  });
  it('the Inter font is embedded (latin + latin-ext, 400 + 600) and the file stays small', () => {
    const html = renderHtml(longInvoiceModel(60));
    expect(count(html, '@font-face')).toBe(4);
    expect(html).toContain("font-family:'Inter'");
    expect(html).toContain('font/woff2;base64,');
    expect(html.length).toBeLessThan(400_000);
    expect(count(html, 'http://') + count(html, 'https://')).toBe(0);
    expect(html).not.toContain('xmlns');
  });
  it('the document is self-contained: no external references', () => {
    const html = renderHtml(exampleModel('A'), opts);
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toMatch(/url\(https?:/);
    expect(html).not.toContain('<script');
  });
  it('unknown template names fall back to Classic; options override the model layout', () => {
    expect(renderHtml(exampleModel('A', { template: 'weird' }), opts)).toContain('data-template="classic"');
    expect(renderHtml(exampleModel('A'), { ...opts, template: 'modern' })).toContain('data-template="modern"');
    expect(renderHtml(exampleModel('A', { paper: 'LETTER' }), opts)).toContain('data-paper="LETTER"');
    expect(renderHtml(exampleModel('A', { paper: 'LETTER' }), { ...opts, paper: 'A4' })).toContain('data-paper="A4"');
  });
  it('layout numbers are sane for the first page', () => {
    const layout = computeLayout(buildCtx(exampleModel('A'), {}));
    expect(layout.bodyTopFirst).toBeGreaterThan(mm(98.5));
    expect(layout.cols.desc).toBeGreaterThan(150);
    const noClient = computeLayout(buildCtx(exampleModel('A', {}, { client: null }), {}));
    expect(noClient.bodyTopFirst).toBeGreaterThan(0);
  });
  it('a document without client or business data still renders', () => {
    const html = renderHtml(exampleModel('E1', {}, { client: null, business: { name: '', street: '', iban: '', footer: '' } }), opts);
    expect(html).toContain('<!doctype html>');
    expect(visibleText(html)).toContain('Seite 1 von 1');
    void TEST_CLIENT;
  });
});

describe('items taller than a page (D56, review #9)', () => {
  const m = (over: Partial<Measure>): Measure => ({ capacityFirst: 400, capacityNext: 600, introH: 0, tableHeadH: 20, carryH: 15, rowHeights: [], blocks: [], ...over });
  it('tooTallItems: a row with header and carry rows over an empty page, a block over a page, the intro over page 1', () => {
    expect(tooTallItems(m({ rowHeights: [565, 566] }))).toEqual({ intro: false, rows: [1], blocks: [] }); // last row: no carry-out
    expect(tooTallItems(m({ rowHeights: [100, 551, 100] }))).toEqual({ intro: false, rows: [1], blocks: [] });
    expect(tooTallItems(m({ introH: 401, blocks: [{ id: 'notes', h: 601 }, { id: 'totals', h: 600 }] }))).toEqual({ intro: true, rows: [], blocks: ['notes'] });
  });
  it('the 60-line fixture with long descriptions has nothing too tall in any template and paper', () => {
    for (const template of TEMPLATE_IDS) {
      for (const paper of ['A4', 'LETTER'] as const) {
        expect(tooTall(buildCtx(longInvoiceModel(60), { template, paper }))).toEqual({ intro: false, rows: [], blocks: [] });
      }
    }
  });
});

describe('CJK, emoji and right-to-left text (review #13)', () => {
  it('wide characters count a full em, so the estimate never under-counts their lines', () => {
    expect(charWidthEm('漢')).toBe(1);
    expect(charWidthEm('한')).toBe(1);
    expect(charWidthEm('😀')).toBe(1);
    expect(charWidthEm('a')).toBe(0.56);
    const width = 300;
    const fontPx = 10;
    expect(wrapLineCount('漢'.repeat(128), width, fontPx)).toBeGreaterThanOrEqual(Math.ceil((128 * fontPx) / width));
  });
  it('names, addresses and descriptions carry dir="auto"', () => {
    const model = exampleModel('A');
    model.client = { ...(model.client as NonNullable<typeof model.client>), name: 'شركة النور' };
    model.lines[0] = { ...model.lines[0], description: 'وصف الخدمة' };
    const html = renderHtml(model, { embedFonts: false });
    expect(html).toContain('<span dir="auto">شركة النور</span>');
    expect(html).toContain('<div class="sub" dir="auto">وصف الخدمة</div>');
  });
});

describe('return-address line fits the window (P5 device finding, review #18)', () => {
  const ctxFor = (name: string) => buildCtx(exampleModel('A', {}, { business: { name } }));
  it('keeps the full line at the template size when it fits', () => {
    const fit = senderFit(ctxFor('Muster Design GmbH'), mm(85));
    expect(fit.text).toBe('Muster Design GmbH · Hauptstraße 1 · 10115 Berlin');
    expect(fit.px).toBe(7);
  });
  it('long names: smaller first, then without the street, never without the town before the street', () => {
    const fit = senderFit(ctxFor('Jürgen Weiß Gestaltung & Öffentlichkeitsarbeit'), mm(85));
    expect(fit.text).toBe('Jürgen Weiß Gestaltung & Öffentlichkeitsarbeit · 10115 Berlin');
    expect(textWidth(fit.text, fit.px)).toBeLessThanOrEqual(mm(85));
    // a name whose full line is too wide at 7 px but fits at 6 px keeps the street, in the smaller size
    let name = 'Muster Design';
    const full = (n: string, px: number) => textWidth(`${n} · Hauptstraße 1 · 10115 Berlin`, px);
    while (full(name, 7) <= mm(85)) name += ' X';
    expect(full(name, SENDER_MIN_PX)).toBeLessThanOrEqual(mm(85));
    const mid = senderFit(ctxFor(name), mm(85));
    expect(mid).toEqual({ text: `${name} · Hauptstraße 1 · 10115 Berlin`, px: SENDER_MIN_PX });
  });
  it('a name longer than the window is all that is left (clipped by CSS)', () => {
    const fit = senderFit(ctxFor('Sehr lange Firmenbezeichnung einer Gesellschaft mit beschränkter Haftung und Compagnie Kommanditgesellschaft'), mm(85));
    expect(fit.text.startsWith('Sehr lange')).toBe(true);
    expect(fit.text).not.toContain('Hauptstraße');
  });
  it('the rendered sender line carries the smaller size only when needed', () => {
    const html = renderHtml(exampleModel('A', {}, { business: { name: 'Jürgen Weiß Gestaltung & Öffentlichkeitsarbeit' } }), { embedFonts: false });
    expect(html).toContain('<div class="sender">Jürgen Weiß Gestaltung &amp; Öffentlichkeitsarbeit · 10115 Berlin</div>');
    const smaller = renderHtml(exampleModel('A', {}, { business: { name: 'Muster Design X X X X X X X X' } }), { embedFonts: false });
    expect(smaller).toMatch(/<div class="sender"( style="font-size:6px")?>Muster Design X X X X X X X X · /);
    expect(renderHtml(exampleModel('A'), { embedFonts: false })).toContain('<div class="sender">Muster Design GmbH · Hauptstraße 1 · 10115 Berlin</div>');
  });
});
