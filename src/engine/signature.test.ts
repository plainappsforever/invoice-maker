import { MAX_SIGNATURE_CHARS, parseSignature, serializeSignature, signatureFromStrokes, signatureSvg, simplify, type Stroke } from './signature';

const line = (n: number, y = 10): Stroke => Array.from({ length: n }, (_, i) => ({ x: 20 + i, y }));

describe('signature', () => {
  it('no ink → null', () => {
    expect(signatureFromStrokes([])).toBeNull();
    expect(signatureFromStrokes([[], [{ x: NaN, y: 1 }]])).toBeNull();
  });
  it('crops to the ink with a 4 pt margin and simplifies straight runs to their end points', () => {
    const sig = signatureFromStrokes([line(100)]);
    expect(sig).toEqual({ v: 1, w: 107, h: 8, d: 'M4 4 L103 4' });
  });
  it('a tap is a dot (zero-length segment); several strokes become several M runs', () => {
    expect(signatureFromStrokes([[{ x: 5, y: 5 }]])?.d).toBe('M4 4 L4 4');
    const sig = signatureFromStrokes([line(3, 0), [{ x: 0.04, y: 20.06 }, { x: 10, y: 30 }]]);
    expect(sig?.d).toBe('M24 4 L26 4 M4 24.1 L14 34');
  });
  it('keeps corners', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(simplify(pts)).toEqual(pts);
    expect(simplify([{ x: 0, y: 0 }, { x: 5, y: 0.3 }, { x: 10, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  });
  it('a long scribble stays under the size cap, or is refused (never truncated silently)', () => {
    const zigzag: Stroke = Array.from({ length: 20_000 }, (_, i) => ({ x: i * 3, y: i % 2 ? 0 : 50 }));
    expect(signatureFromStrokes([zigzag])).toBeNull();
    const ok = signatureFromStrokes([Array.from({ length: 400 }, (_, i) => ({ x: i, y: Math.sin(i / 5) * 30 }))]);
    expect(ok && ok.d.length).toBeLessThan(MAX_SIGNATURE_CHARS);
  });
  it('round trips through its text and refuses anything outside the grammar', () => {
    const sig = signatureFromStrokes([line(10), [{ x: 1, y: 1 }, { x: 30.27, y: 2.04 }]]);
    expect(sig).not.toBeNull();
    expect(parseSignature(serializeSignature(sig!))).toEqual(sig);
    for (const bad of [
      null, '', 'x', '[]', '{"v":1,"w":10,"h":10}', '{"v":2,"w":10,"h":10,"d":"M1 1 L2 2"}',
      '{"v":1,"w":10,"h":10,"d":"M1 1 L2 2\\"/><script>alert(1)</script>"}', '{"v":1,"w":10,"h":10,"d":"M1 1 C2 2 3 3 4 4"}',
      '{"v":1,"w":0,"h":10,"d":"M1 1"}', '{"v":1,"w":10,"h":10,"d":"M1 1","x":1}', '{"v":1,"w":1.5,"h":10,"d":"M1 1"}',
    ]) expect(parseSignature(bad)).toBeNull();
  });
  it('SVG for the PDF', () => {
    const svg = signatureSvg({ v: 1, w: 100, h: 40, d: 'M4 4 L96 36' }, 15, 'red"/>');
    expect(svg).toContain('viewBox="0 0 100 40"');
    expect(svg).toContain('d="M4 4 L96 36"');
    expect(svg).toContain('stroke="#1a1a1a"');
    expect(svg).toContain('height:15mm');
  });
});
