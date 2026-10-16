import { DocumentLockedError } from '@/db/types';
import { setUiLanguage } from '@/i18n';

import { errorText } from './errors';
import { TimeoutError } from './timeout';

describe('errorText (review #21)', () => {
  it('turns known failures into German sentences and keeps unknown messages', () => {
    setUiLanguage('de');
    expect(errorText(new TimeoutError('Creating the PDF', 60_000))).toBe('Das PDF zu erstellen hat länger als 60 Sekunden gedauert.');
    expect(errorText(new DocumentLockedError(3))).toMatch(/bereits ausgestellt/);
    expect(errorText(new Error('Error code 13: database or disk is full'))).toMatch(/Speicher des Telefons ist voll/);
    expect(errorText(new Error('issue: 10000 numbers in a row already exist; raise "next number"'))).toMatch(/10\.000 Nummern/);
    expect(errorText(new Error('something else'))).toBe('something else');
    expect(errorText('plain')).toBe('plain');
    setUiLanguage('en');
    expect(errorText(new TimeoutError('Creating the PDF', 60_000))).toBe('Creating the PDF took longer than 60 seconds.');
  });
});
