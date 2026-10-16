import { clipboardText, documentText, mailContent, pdfFileName, sanitizeFileName, storedPdfPath } from './send-text';
import { exampleModel } from './test-models';

describe('pdfFileName (D66)', () => {
  it('is "<number> <client>.pdf" and keeps umlauts', () => {
    expect(pdfFileName(exampleModel('A', {}, { client: { name: 'Müller GmbH' } }))).toBe('RE-2026-0001 Müller GmbH.pdf');
    expect(pdfFileName(exampleModel('A'))).toBe('RE-2026-0001 Kunde & Söhne GmbH.pdf'); // < > removed
  });
  it('names drafts by type and "Entwurf"/"Draft" in the document language', () => {
    const model = { ...exampleModel('A', {}, { client: { name: 'Müller GmbH' } }), number: null };
    expect(pdfFileName(model)).toBe('Rechnung Entwurf Müller GmbH.pdf');
    const en = { ...exampleModel('D'), number: null };
    expect(pdfFileName(en)).toMatch(/^Invoice Draft .+\.pdf$/);
  });
  it('removes characters that file systems and mail clients reject', () => {
    const model = exampleModel('A', {}, { client: { name: 'A/B: "C" <D>* E?|F\\G\u0007 #1 %2' } });
    const name = pdfFileName(model);
    expect(name).toBe('RE-2026-0001 A B C D E F G 1 2.pdf');
    expect(name).not.toMatch(/[\\/:*?"<>|#%]/);
  });
  it('works without a client and cuts very long names without splitting characters', () => {
    expect(pdfFileName(exampleModel('A', {}, { client: null }))).toBe('RE-2026-0001.pdf');
    const long = pdfFileName(exampleModel('A', {}, { client: { name: '漢字😀'.repeat(60) } }));
    expect(Array.from(long.replace(/\.pdf$/, '')).length).toBeLessThanOrEqual(80);
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
  });
  it('never returns an empty or dot name', () => {
    expect(sanitizeFileName('...')).toBe('');
    expect(sanitizeFileName(' a. ')).toBe('a');
    expect(pdfFileName(exampleModel('A', {}, { client: { name: '???' } }))).toBe('RE-2026-0001.pdf');
  });
});

describe('storedPdfPath', () => {
  it('is pdf/<id>-<number>.pdf, with the paid amount when there are payments', () => {
    expect(storedPdfPath(7, 'RE-2026-0001', 0)).toBe('pdf/7-RE-2026-0001.pdf');
    expect(storedPdfPath(7, 'RE/2026 01', 5000)).toBe('pdf/7-RE_2026_01-paid5000.pdf');
  });
});

describe('mailContent (D25)', () => {
  it('German invoice: subject, greeting, amount, due date, sender; recipient = client e-mail', () => {
    const model = exampleModel('A', { dueDate: '2026-10-15' }, { client: { email: 'einkauf@mueller.example', contact: '' } });
    const mail = mailContent(model, model.totals.gross);
    expect(mail.to).toEqual(['einkauf@mueller.example']);
    expect(mail.body.startsWith('Guten Tag,\n\nanbei')).toBe(true);
    expect(mail.subject).toBe('Rechnung RE-2026-0001 – Muster Design GmbH');
    expect(mail.body).toContain('Guten Tag,');
    expect(mail.body).toContain('Rechnung RE-2026-0001 vom 01.10.2026 über 1.330,29\u00a0€, zahlbar bis 15.10.2026.');
    expect(mail.body.endsWith('Mit freundlichen Grüßen\nMuster Design GmbH')).toBe(true);
  });
  it('uses the balance after payments and the contact name', () => {
    const model = exampleModel('A', { dueDate: '2026-10-15' }, { client: { contact: 'Frau Müller' } });
    const mail = mailContent(model, 33_029);
    expect(mail.body).toContain('Guten Tag Frau Müller,');
    expect(mail.body).toContain('über 330,29\u00a0€');
  });
  it('English document → English text whatever the UI language', () => {
    const model = exampleModel('D');
    const mail = mailContent(model);
    expect(mail.subject.startsWith('Invoice ')).toBe(true);
    expect(mail.body).toContain('Please find attached invoice');
    expect(mail.body).toContain('Kind regards');
  });
  it('a paid invoice and other types get the neutral sentence; no client e-mail → no recipient', () => {
    const model = exampleModel('A', {}, { client: { email: '' } });
    expect(mailContent(model, 0).body).toContain('anbei erhalten Sie: Rechnung RE-2026-0001 vom 01.10.2026.');
    expect(mailContent(model, 0).to).toEqual([]);
    const storno = exampleModel('F');
    expect(mailContent(storno).body).toContain('Stornorechnung RE-2026-0002');
  });
  it('quote with validity', () => {
    const model = { ...exampleModel('A', { validUntil: '2026-10-31' }), type: 'quote' as const, number: 'AN-2026-0001' };
    expect(mailContent(model).body).toContain('Angebot AN-2026-0001 vom 01.10.2026 über 1.330,29\u00a0€, gültig bis 31.10.2026.');
  });
  it('clipboard text = subject, blank line, body', () => {
    const mail = mailContent(exampleModel('A'));
    expect(clipboardText(mail)).toBe(`${mail.subject}\n\n${mail.body}`);
  });
});

describe('documentText (Share as text fallback)', () => {
  it('lists lines and the totals of the engine', () => {
    const model = exampleModel('A', { dueDate: '2026-10-15' });
    const text = documentText(model);
    expect(text.split('\n')[0]).toBe('Rechnung RE-2026-0001');
    expect(text).toContain('1. Webdesign');
    expect(text).toContain('Netto: 1.122,66\u00a0€\nUSt.: 207,63\u00a0€\nGesamtbetrag: 1.330,29\u00a0€');
    expect(text).toContain('IBAN: DE89370400440532013000');
    expect(text).toContain('15.10.2026');
  });
});
