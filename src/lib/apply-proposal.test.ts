import { EMPTY_CONTACT } from '@/engine/contact-parse';

import { applyProposal } from './apply-proposal';

const blank = { kind: 'business' as const, name: '', contact: '', street: '', postalCode: '', city: '', countryCode: 'DE', email: '', phone: '', vatId: '', notes: 'x' };

describe('applyProposal', () => {
  it('fills a new client completely, including kind and a foreign country', () => {
    const r = applyProposal(blank, { ...EMPTY_CONTACT, kind: 'person', name: 'Eva Klein', street: 'Ring 5', postalCode: '1010', city: 'Wien', countryCode: 'AT', email: 'eva@x.at' });
    expect(r.form).toEqual({ ...blank, kind: 'person', name: 'Eva Klein', street: 'Ring 5', postalCode: '1010', city: 'Wien', countryCode: 'AT', email: 'eva@x.at' });
    expect(r).toEqual(expect.objectContaining({ filled: 6, kept: 0 }));
  });
  it('never overwrites what the user typed; counts what it kept; empty proposal fields change nothing', () => {
    const typed = { ...blank, name: 'Meine GmbH', email: 'mine@x.de', countryCode: 'DE' };
    const r = applyProposal(typed, { ...EMPTY_CONTACT, kind: 'person', name: 'Other', email: 'other@x.de', phone: '030 1', countryCode: 'AT' });
    expect(r.form).toEqual({ ...typed, phone: '030 1' });
    expect(r).toEqual(expect.objectContaining({ filled: 1, kept: 3 }));
  });
});
