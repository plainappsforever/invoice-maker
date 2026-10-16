import { fieldsFromContact } from './contact-map';

describe('fieldsFromContact', () => {
  it('a company contact: company is the client, the person the contact; work address, primary e-mail', () => {
    expect(
      fieldsFromContact({
        name: 'Eva Klein', firstName: 'Eva', lastName: 'Klein', company: 'Beta AG',
        emails: [{ email: 'privat@x.de', label: 'home' }, { email: 'Eva@Beta.at', label: 'work' }],
        phoneNumbers: [{ number: '+43 1 234', label: 'mobile', isPrimary: true }],
        addresses: [{ street: 'Privatweg 1', city: 'Linz', label: 'home' }, { street: 'Ring 5\nStiege 2', postalCode: '1010', city: 'Wien', isoCountryCode: 'at', label: 'work' }],
      })
    ).toEqual({ kind: 'business', name: 'Beta AG', contact: 'Eva Klein', street: 'Ring 5, Stiege 2', postalCode: '1010', city: 'Wien', countryCode: 'AT', email: 'eva@beta.at', phone: '+43 1 234', vatId: '' });
  });
  it('a person without company; missing parts stay empty', () => {
    expect(fieldsFromContact({ name: 'Max Muster', firstName: 'Max', lastName: 'Muster' })).toEqual(
      expect.objectContaining({ kind: 'person', name: 'Max Muster', contact: '', street: '', email: '', phone: '', countryCode: '' })
    );
    expect(fieldsFromContact({ name: 'Nur Display' }).name).toBe('Nur Display');
    expect(fieldsFromContact({}).kind).toBe('');
  });
});
