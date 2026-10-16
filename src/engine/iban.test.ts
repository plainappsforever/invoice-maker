import { formatIban, ibanMod97, isEeaIban, isSepaCountry, isValidBic, normalizeIban, validateIban } from './iban';

describe('IBAN', () => {
  it('accepts valid IBANs in any spacing and case', () => {
    expect(validateIban('DE89370400440532013000')).toBeNull();
    expect(validateIban('de89 3704 0044 0532 0130 00')).toBeNull();
    expect(validateIban('AT611904300234573201')).toBeNull();
    expect(validateIban('GB82 WEST 1234 5698 7654 32')).toBeNull();
    expect(validateIban('FR1420041010050500013M02606')).toBeNull();
    expect(validateIban('NO9386011117947')).toBeNull();
  });
  it('rejects wrong check digits, lengths and formats', () => {
    expect(validateIban('DE89370400440532013001')).toBe('checksum');
    expect(validateIban('DE88370400440532013000')).toBe('checksum');
    expect(validateIban('DE8937040044053201300')).toBe('wrong_length');
    expect(validateIban('')).toBe('empty');
    expect(validateIban('1234')).toBe('invalid_format');
    expect(validateIban('DE89-3704-0044-0532-0130-0!')).toBe('invalid_format');
  });
  it('detects every single-digit typo in the example IBAN', () => {
    const iban = 'DE89370400440532013000';
    for (let i = 4; i < iban.length; i++) {
      const d = Number(iban[i]);
      const typo = iban.slice(0, i) + String((d + 1) % 10) + iban.slice(i + 1);
      expect(ibanMod97(typo)).not.toBe(1);
    }
  });
  it('formats in groups of four', () => {
    expect(formatIban('DE89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
    expect(normalizeIban(' de89 3704-0044 ')).toBe('DE8937040044');
    expect(isSepaCountry('DE89370400440532013000')).toBe(true);
    expect(isSepaCountry('US00')).toBe(false);
  });
});

describe('BIC', () => {
  it('accepts 8 and 11 characters', () => {
    expect(isValidBic('COBADEFFXXX')).toBe(true);
    expect(isValidBic('cobadeff')).toBe(true);
    expect(isValidBic('COBADEF')).toBe(false);
    expect(isValidBic('C0BADEFF')).toBe(false);
  });
});

describe('EEA (review #11)', () => {
  it('EU + IS, LI, NO; not CH, GB, MC, SM, VA, AD, GI', () => {
    for (const iban of ['DE89370400440532013000', 'NO9386011117947', 'IS140159260076545510730339', 'LI21088100002324013AA']) expect(isEeaIban(iban)).toBe(true);
    for (const iban of ['CH9300762011623852957', 'GB29NWBK60161331926819', 'MC5811222000010123456789030', 'BR1800360305000010009795493C1']) expect(isEeaIban(iban)).toBe(false);
  });
});
