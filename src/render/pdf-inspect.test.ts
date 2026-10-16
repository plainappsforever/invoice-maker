import { inspectPdf, stablePdfText } from './pdf-inspect';

const enc = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff));

function samplePdf(opts: { pages: number; box?: string; date?: string; id?: string; prefix?: string }) {
  const kids = Array.from({ length: opts.pages }, (_, i) => `${10 + i} 0 R`).join(' ');
  const pages = Array.from(
    { length: opts.pages },
    (_, i) => `${10 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${opts.box ?? '595 842'}] /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`
  ).join('');
  return enc(
    `%PDF-1.3\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /MediaBox [0 0 595 842] /Count ${opts.pages} /Kids [ ${kids} ] >>\nendobj\n` +
      pages +
      `5 0 obj\n<< /Type /Font /Subtype /TrueType /BaseFont /${opts.prefix ?? 'AAAAAA'}+Inter-Regular /FontDescriptor 6 0 R >>\nendobj\n` +
      `6 0 obj\n<< /Type /FontDescriptor /FontName /${opts.prefix ?? 'AAAAAA'}+Inter-Regular /FontFile2 7 0 R >>\nendobj\n` +
      `8 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica >>\nendobj\n` +
      `9 0 obj\n<< /Producer (macOS) /CreationDate (${opts.date ?? "D:20261002010203Z00'00'"}) /ModDate (${opts.date ?? "D:20261002010203Z00'00'"}) >>\nendobj\n` +
      `trailer\n<< /Size 20 /Root 1 0 R /Info 9 0 R /ID [ <${opts.id ?? 'ab12'}> <${opts.id ?? 'ab12'}> ] >>\n%%EOF\n`
  );
}

describe('inspectPdf', () => {
  it('counts leaf pages (not the /Pages node), reads sizes, fonts and embedded font programs', () => {
    const info = inspectPdf(samplePdf({ pages: 3 }));
    expect(info.version).toBe('1.3');
    expect(info.pages).toBe(3);
    expect(info.treeCount).toBe(3);
    expect(info.mediaBoxes).toEqual([[595, 842], [595, 842], [595, 842]]);
    expect(info.fonts).toEqual(['Helvetica', 'Inter-Regular']);
    expect(info.embeddedFonts).toBe(1);
    expect(info.objectStreams).toBe(false);
  });
  it('reads Letter boxes with offsets and decimals', () => {
    const info = inspectPdf(samplePdf({ pages: 1, box: '612 792' }));
    expect(info.mediaBoxes).toEqual([[612, 792]]); // the leaf's own box wins over the tree's 595 × 842
    const shifted = inspectPdf(enc('%PDF-1.4\n3 0 obj\n<< /Type /Page /MediaBox [ 10 20 622.04 812 ] >>\nendobj\n'));
    expect(shifted.mediaBoxes).toEqual([[612, 792]]);
    expect(shifted.pages).toBe(1);
  });
  it('flags compressed object streams', () => {
    expect(inspectPdf(enc('%PDF-1.5\n1 0 obj << /Type /ObjStm /N 3 >>')).objectStreams).toBe(true);
  });
});

it('a leaf page without its own box inherits the page tree box', () => {
  const pdf = enc('%PDF-1.4\n2 0 obj\n<< /Type /Pages /MediaBox [0 0 612 792] /Count 1 /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n');
  expect(inspectPdf(pdf).mediaBoxes).toEqual([[612, 792]]);
});

describe('stablePdfText', () => {
  it('ignores dates, the document ID and subset prefixes, nothing else', () => {
    const a = samplePdf({ pages: 2 });
    const b = samplePdf({ pages: 2, date: "D:20261003111111Z00'00'", id: 'ff99', prefix: 'QWERTY' });
    expect(stablePdfText(a)).toBe(stablePdfText(b));
    expect(stablePdfText(a)).not.toBe(stablePdfText(samplePdf({ pages: 3 })));
  });
});
