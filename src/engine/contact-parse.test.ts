import fixtures from './__fixtures__/contact-texts.json';
import { CONTACT_FIELDS, parseContactText, type ContactField, type ContactFields } from './contact-parse';

type Case = { id: string; source: string; lines: string[]; own?: Record<string, string>; expect: Partial<ContactFields> };
const cases = (fixtures as { cases: Case[] }).cases;

/** Phones compare by digits (and a leading +); everything else exactly. */
const norm = (field: ContactField, v: string) => (field === 'phone' ? v.replace(/[^\d+]/g, '') : v.trim());

function expected(c: Case): ContactFields {
  const e = { kind: '', name: '', contact: '', street: '', postalCode: '', city: '', countryCode: '', email: '', phone: '', vatId: '', ...c.expect };
  return e as ContactFields;
}

function measure() {
  const table: Record<string, { right: number; wrong: number; missed: number; falseFill: number }> = {};
  const failures: string[] = [];
  for (const f of CONTACT_FIELDS) table[f] = { right: 0, wrong: 0, missed: 0, falseFill: 0 };
  for (const c of cases) {
    const got = parseContactText(c.lines, { own: c.own }).fields;
    const want = expected(c);
    for (const f of CONTACT_FIELDS) {
      const g = norm(f, got[f]);
      const w = norm(f, want[f]);
      const row = table[f];
      if (g === w) row.right++;
      else if (!w) row.falseFill++;
      else if (!g) row.missed++;
      else row.wrong++;
      if (g !== w) failures.push(`${c.id} ${f}: got "${got[f]}" want "${want[f]}"`);
    }
  }
  return { table, failures };
}

describe('contact-text parser on the 70 fixture texts (not blind: same author, WORKFLOW L27 rule 4)', () => {
  it('per-field accuracy', () => {
    const { table, failures } = measure();
    const lines = Object.entries(table).map(([f, r]) => `${f.padEnd(12)} ${String(r.right).padStart(2)}/${cases.length}  wrong ${r.wrong}  missed ${r.missed}  false ${r.falseFill}`);
    if (process.env.CONTACT_REPORT) console.log(`${lines.join('\n')}\n\n${failures.join('\n')}`);
    expect(cases.length).toBe(70);
    const total = Object.values(table).reduce((n, r) => n + r.right, 0);
    // Regression floor: 699/700 when the set was last measured (the one miss is letter-06's interleaved footer).
    expect(total).toBeGreaterThanOrEqual(699);
    for (const f of ['email', 'phone', 'postalCode', 'city', 'vatId'] as const) expect(table[f].falseFill).toBe(0);
  });
});

describe('second set (written after the parser was frozen and measured once at 248/300; used for fixes since)', () => {
  it('per-field accuracy', () => {
    const held = (require('./__fixtures__/contact-texts-heldout.json') as { cases: Case[] }).cases;
    const table: Record<string, number> = {};
    const failures: string[] = [];
    for (const f of CONTACT_FIELDS) table[f] = 0;
    for (const c of held) {
      const got = parseContactText(c.lines, { own: c.own }).fields;
      const want = expected(c);
      for (const f of CONTACT_FIELDS) {
        if (norm(f, got[f]) === norm(f, want[f])) table[f]++;
        else failures.push(`${c.id} ${f}: got "${got[f]}" want "${want[f]}"`);
      }
    }
    if (process.env.CONTACT_REPORT) console.log(`${Object.entries(table).map(([f, n]) => `${f.padEnd(12)} ${n}/${held.length}`).join('\n')}\n\n${failures.join('\n')}`);
    expect(held.length).toBe(30);
    // First measurement 248/300 (before any fix; recorded in the fixture's 'about'). After general fixes: floor 297.
    expect(Object.values(table).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(297);
  });
});

describe('parser rules', () => {
  it('leaves everything empty when the text has no contact detail', () => {
    expect(parseContactText(['Max Mustermann', 'Lorem ipsum']).fields.name).toBe('');
    expect(parseContactText('').fields).toEqual(expect.objectContaining({ name: '', email: '', phone: '' }));
  });
  it('takes a text with newlines and fixes OCR slips in postcode, phone and e-mail', () => {
    const f = parseContactText('Beispiel GmbH\nHauptstr.1\n1O115 Berlin\nTel. O30 l23 4567\ninfo@beispiel,de').fields;
    expect(f).toEqual(expect.objectContaining({ name: 'Beispiel GmbH', street: 'Hauptstr. 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE', email: 'info@beispiel.de' }));
    expect(f.phone.replace(/\D/g, '')).toBe('0301234567');
  });
  it('skips the user\'s own block in a letter', () => {
    const f = parseContactText(['Sender GmbH · Weg 1 · 10115 Berlin', 'Herrn', 'Eigen Name', 'Eigenstraße 2', '20095 Hamburg'], { own: { name: 'Eigen Name' } }).fields;
    expect(f).toEqual(expect.objectContaining({ name: 'Sender GmbH', street: 'Weg 1', postalCode: '10115' }));
  });
  it('a German VAT number without the DE prefix gets it from the address', () => {
    expect(parseContactText(['Muster GmbH', 'Weg 1', '10115 Berlin', 'USt-IdNr. 123 456 789']).fields.vatId).toBe('DE123456789');
  });
  it('never reads a fax number, an IBAN or a date as the phone', () => {
    const f = parseContactText(['Muster GmbH', 'Fax 030 999999', 'IBAN DE89 3704 0044 0532 0130 00', 'Berlin, 12.10.2026', '10115 Berlin']).fields;
    expect(f.phone).toBe('');
  });
});
