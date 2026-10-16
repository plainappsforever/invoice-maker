// V1.5 P1 additions to the PDF: delivery address, item photos, the business signature, the client's acceptance
// signature on a quote copy, and photos printed as pages after the document (numbering and footers continue).
import { serializeSignature, signatureFromStrokes } from '@/engine/signature';
import { exampleModel, longInvoiceModel } from '@/render/test-models';
import type { RenderModel } from '@/render/model';

import { buildCtx, computeLayout, paginate, renderHtml, TEMPLATE_IDS, tooTall } from './index';
import { rowHeight, THUMB_H } from './paginate';

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const SIG = serializeSignature(signatureFromStrokes([[{ x: 0, y: 0 }, { x: 30, y: 10 }, { x: 60, y: 2 }]])!);
const pagesOf = (html: string) => html.split('<section class="page"').slice(1);
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function withShip(model: RenderModel, countryCode = 'DE'): RenderModel {
  return { ...model, client: { ...model.client!, shipTo: { name: 'Lager Nord', street: 'Hafenstraße 1', postalCode: '20457', city: 'Hamburg', countryCode } } };
}

describe('delivery address', () => {
  it('prints one line above the intro, with the foreign country named; nothing for model-1 snapshots', () => {
    const de = renderHtml(withShip(exampleModel('A')), { embedFonts: false });
    expect(text(de)).toContain('Lieferanschrift: Lager Nord, Hafenstraße 1, 20457 Hamburg');
    const en = renderHtml(withShip(exampleModel('A', { language: 'en' }), 'AT'), { embedFonts: false });
    expect(text(en)).toContain('Delivery address: Lager Nord, Hafenstraße 1, 20457 Hamburg, Austria');
    expect(renderHtml(exampleModel('A'), { embedFonts: false })).not.toContain('data-block="shipto"');
  });
  it('counts in the first-page height', () => {
    const plain = exampleModel('A');
    const ctxA = buildCtx(plain);
    const ctxB = buildCtx(withShip(plain));
    const measure = (ctx: typeof ctxA) => paginate(ctx, computeLayout(ctx))[0].usedPx;
    expect(measure(ctxB)).toBeGreaterThan(measure(ctxA));
  });
});

describe('item photos', () => {
  const model = (): RenderModel => {
    const m = exampleModel('A');
    return { ...m, lines: m.lines.map((l, i) => (i === 0 ? { ...l, imageFile: 'items/a.jpg' } : l)) };
  };
  it('a line with a usable photo shows it and its row grows by the photo height', () => {
    const m = model();
    const html = renderHtml(m, { embedFonts: false, images: { 'items/a.jpg': JPG } });
    expect(html.split('class="thumb"').length - 1).toBe(1);
    const withImg = buildCtx(m, { images: { 'items/a.jpg': JPG } });
    const without = buildCtx(m);
    const grew = rowHeight(withImg, computeLayout(withImg), 0) - rowHeight(without, computeLayout(without), 0);
    expect(grew).toBeGreaterThanOrEqual(Math.floor(THUMB_H + 3));
    expect(grew).toBeLessThanOrEqual(Math.ceil(THUMB_H + 3) + 1);
  });
  it('no data, or data that is not a PNG/JPEG data URI → the line prints without a photo', () => {
    expect(renderHtml(model(), { embedFonts: false })).not.toContain('class="thumb"');
    expect(renderHtml(model(), { embedFonts: false, images: { 'items/a.jpg': 'javascript:alert(1)' } })).not.toContain('class="thumb"');
    expect(renderHtml(model(), { embedFonts: false, images: { 'items/a.jpg': 'data:image/svg+xml;base64,PHN2Zz4=' } })).not.toContain('class="thumb"');
  });
  it('60 photo lines still paginate without a row taller than a page', () => {
    const long = longInvoiceModel(60);
    const m = { ...long, lines: long.lines.map((l) => ({ ...l, imageFile: 'items/a.jpg' })) };
    const ctx = buildCtx(m, { images: { 'items/a.jpg': JPG } });
    expect(tooTall(ctx).rows).toEqual([]);
    const html = renderHtml(m, { embedFonts: false, images: { 'items/a.jpg': JPG } });
    expect(html.split('class="thumb"').length - 1).toBe(60);
    expect(pagesOf(html).length).toBeGreaterThan(pagesOf(renderHtml(long, { embedFonts: false })).length);
  });
});

describe('signatures', () => {
  it('the business signature prints under the document (all templates), the client signature only on a quote copy', () => {
    for (const template of TEMPLATE_IDS) {
      const m = exampleModel('A', { template });
      const html = renderHtml({ ...m, business: { ...m.business, signature: SIG } }, { embedFonts: false });
      expect(html).toContain('data-block="signature"');
      expect(html).toContain('<path d="M');
    }
    const quote = exampleModel('A', {}, {});
    const q = { ...quote, type: 'quote' as const };
    const signed = renderHtml(q, { embedFonts: false, acceptance: { signer: 'Eva Klein', signedAt: '14.10.2026', signature: SIG } });
    expect(text(signed)).toContain('Angenommen von Eva Klein am 14.10.2026');
    expect(renderHtml(exampleModel('A'), { embedFonts: false, acceptance: { signer: 'X', signedAt: '1', signature: SIG } })).not.toContain('data-block="acceptance"');
  });
  it('a damaged or hostile stored signature prints nothing', () => {
    const m = exampleModel('A');
    const evil = '{"v":1,"w":9,"h":9,"d":"M1 1\\"/><script>alert(1)</script>"}';
    const html = renderHtml({ ...m, business: { ...m.business, signature: evil } }, { embedFonts: false });
    expect(html).not.toContain('data-block="signature"');
    expect(html).not.toContain('<script');
  });
});

describe('attachment pages', () => {
  const twelve = (m: RenderModel): RenderModel => ({
    ...m,
    attachments: Array.from({ length: 12 }, (_, i) => ({ file: `attachments/${i}.jpg`, name: i === 0 ? 'Quittung Baumarkt' : '', width: 800, height: 1100 })),
  });
  const images = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`attachments/${i}.jpg`, JPG]));

  it('an invoice with 12 photo pages keeps numbering and footers on every page', () => {
    for (const template of TEMPLATE_IDS) {
      const base = exampleModel('A', { template });
      const plain = pagesOf(renderHtml(base, { embedFonts: false })).length;
      const html = renderHtml(twelve(base), { embedFonts: false, images });
      const pages = pagesOf(html);
      const total = plain + 12;
      expect(pages).toHaveLength(total);
      expect(html).toContain(`data-pages="${total}"`);
      pages.forEach((p, i) => {
        expect(p).toContain(`data-page="${i + 1}" data-pages="${total}"`);
        expect(text(p)).toContain(`Seite ${i + 1} von ${total}`);
        expect(p).toContain('class="foot"');
      });
      expect(text(pages[plain])).toContain('Anlage 1: Quittung Baumarkt');
      expect(text(pages[plain + 11])).toContain('Anlage 12');
    }
  });

  it('a photo without data is skipped and the page count says so (never an empty page)', () => {
    const { 'attachments/3.jpg': _gone, ...some } = images;
    const base = exampleModel('A');
    const html = renderHtml(twelve(base), { embedFonts: false, images: some });
    expect(pagesOf(html)).toHaveLength(pagesOf(renderHtml(base, { embedFonts: false })).length + 11);
    expect(html).not.toContain('attachments/3.jpg');
  });

  it('a model-1 snapshot (no new fields) renders exactly as a model-2 one with empty fields', () => {
    const m = exampleModel('A');
    const { attachments: _a, ...v1 } = m;
    const v1Lines = { ...v1, lines: v1.lines.map(({ imageFile: _i, ...l }) => l) } as RenderModel;
    expect(renderHtml(v1Lines, { embedFonts: false })).toBe(renderHtml(m, { embedFonts: false }));
  });
});
