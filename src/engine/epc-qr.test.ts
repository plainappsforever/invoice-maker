import examples from './__fixtures__/worked-examples.json';
import {
  buildEpcPayload,
  EPC_MAX_BYTES,
  formatEpcAmount,
  remittanceText,
  truncateUtf8,
  utf8Length,
} from './epc-qr';

const base = {
  name: 'Muster Design',
  iban: 'DE89370400440532013000',
  amountCents: 103029,
  currency: 'EUR',
  remittance: 'RE-2026-0001',
};

describe('GiroCode payload (EPC069-12 v002)', () => {
  it('Example A matches the SPEC payload byte for byte', () => {
    const expected = examples.examples[0].document.girocode;
    expect(buildEpcPayload(base)).toEqual({ ok: true, payload: expected });
  });

  it('includes a BIC and info when given; normalises the IBAN', () => {
    const r = buildEpcPayload({ ...base, iban: 'de89 3704 0044 0532 0130 00', bic: 'cobadeffxxx', info: 'Danke' });
    expect(r).toEqual({
      ok: true,
      payload: 'BCD\n002\n1\nSCT\nCOBADEFFXXX\nMuster Design\nDE89370400440532013000\nEUR1030.29\n\n\nRE-2026-0001\nDanke',
    });
  });

  it('SEPA only; outside the EEA the BIC is required (EPC069-12 v002, review #11)', () => {
    expect(buildEpcPayload({ ...base, iban: 'BR1800360305000010009795493C1' })).toEqual({ ok: false, error: 'not_sepa' });
    expect(buildEpcPayload({ ...base, iban: 'BR1800360305000010009795493C1', bic: 'CEFXBRSPXXX' })).toEqual({ ok: false, error: 'not_sepa' });
    expect(buildEpcPayload({ ...base, iban: 'CH9300762011623852957' })).toEqual({ ok: false, error: 'bic_required' });
    expect(buildEpcPayload({ ...base, iban: 'GB29NWBK60161331926819' })).toEqual({ ok: false, error: 'bic_required' });
    const ch = buildEpcPayload({ ...base, iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' });
    expect(ch.ok && ch.payload.split('\n')[4]).toBe('UBSWCHZH80A');
    expect(buildEpcPayload({ ...base, iban: 'NO9386011117947' }).ok).toBe(true); // EEA, not EU: BIC optional
    expect(buildEpcPayload({ ...base, iban: 'AT611904300234573201' }).ok).toBe(true);
  });

  it('formats amounts with two decimals', () => {
    expect(formatEpcAmount(1)).toBe('EUR0.01');
    expect(formatEpcAmount(100)).toBe('EUR1.00');
    expect(formatEpcAmount(99_999_999_999)).toBe('EUR999999999.99');
  });

  it.each([
    [{ currency: 'USD' }, 'currency'],
    [{ amountCents: 0 }, 'amount'],
    [{ amountCents: -5 }, 'amount'],
    [{ amountCents: 100_000_000_000 }, 'amount'],
    [{ amountCents: 1.5 }, 'amount'],
    [{ iban: 'DE89370400440532013001' }, 'iban'],
    [{ bic: 'XX' }, 'bic'],
    [{ name: '  ' }, 'name'],
  ])('refuses %p (%s)', (patch, error) => {
    expect(buildEpcPayload({ ...base, ...patch })).toEqual({ ok: false, error });
  });

  it('truncates name to 70 and remittance to 140 characters, removes line breaks', () => {
    const r = buildEpcPayload({ ...base, name: 'N'.repeat(80), remittance: 'R\n'.repeat(100) });
    if (!r.ok) throw new Error('expected ok');
    const lines = r.payload.split('\n');
    expect(lines[5]).toBe('N'.repeat(70));
    expect(lines[10].length).toBeLessThanOrEqual(140);
    expect(lines).toHaveLength(11);
  });

  it('stays within 331 bytes with multi-byte text, never splitting a character', () => {
    const r = buildEpcPayload({
      ...base,
      name: '😀'.repeat(70),
      remittance: 'Ä'.repeat(140),
      info: 'ß'.repeat(70),
    });
    if (!r.ok) throw new Error('expected ok');
    expect(utf8Length(r.payload)).toBeLessThanOrEqual(EPC_MAX_BYTES);
    expect(r.payload).not.toMatch(/�/);
    expect(Buffer.from(r.payload, 'utf8').toString('utf8')).toBe(r.payload);
  });

  it('remittance = number, plus the client name when it fits', () => {
    expect(remittanceText('RE-2026-0001', 'Beispiel GmbH')).toBe('RE-2026-0001 Beispiel GmbH');
    expect(remittanceText('RE-2026-0001', 'x'.repeat(140))).toBe('RE-2026-0001');
    expect(remittanceText('RE-2026-0001')).toBe('RE-2026-0001');
  });

  it('utf8 helpers count bytes like Node does', () => {
    for (const s of ['abc', 'Ä', '€', '😀', 'Grüße 😀 €']) expect(utf8Length(s)).toBe(Buffer.byteLength(s));
    expect(truncateUtf8('ÄÄÄ', 5)).toBe('ÄÄ');
  });
});
