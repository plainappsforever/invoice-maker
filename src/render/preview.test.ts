import { renderHtml } from './html';
import { previewHtml, printHtml, PRINT_TRIM, PRINT_ZOOM } from './preview';
import { exampleModel } from './test-models';

describe('previewHtml', () => {
  it('keeps the document markup and widens the viewport by the desk margin', () => {
    const html = renderHtml(exampleModel('A'), { embedFonts: false });
    const out = previewHtml(html, 'A4');
    expect(out).toContain('<meta name="viewport" content="width=619">');
    expect(out).not.toContain('content="width=595"');
    expect(out.replace(/<style>html,body\{background:#d9d9de\}[^<]*<\/style>/, '').replace('width=619', 'width=595')).toBe(html);
  });
  it('uses the Letter width', () => {
    const out = previewHtml(renderHtml(exampleModel('A', { paper: 'LETTER' }), { embedFonts: false }), 'LETTER');
    expect(out).toContain('content="width=636"');
  });
});

describe('printHtml (D67)', () => {
  it('zooms the document and trims the page boxes for the print engine', () => {
    const html = renderHtml(exampleModel('A'), { embedFonts: false });
    const out = printHtml(html, PRINT_ZOOM.ios, 'A4');
    expect(out).toContain(`<style>html{zoom:1.25}.page{height:${842 - PRINT_TRIM}px}</style></head>`);
    expect(out.replace(/<style>html\{zoom[^<]*<\/style>/, '')).toBe(html);
    expect(printHtml(html, PRINT_ZOOM.android, 'LETTER')).toContain(`html{zoom:${4 / 3}}.page{height:${792 - PRINT_TRIM}px}`);
  });
});
