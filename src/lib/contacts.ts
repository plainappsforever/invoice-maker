// "From contacts" on the client form (V1.5 P1, Idea-c, D97). iOS: the system contact picker (CNContactPickerViewController)
// hands over the one picked contact; the app gets no access to the address book and asks nothing. Android: the system
// picker returns only an id; reading that contact needs READ_CONTACTS, asked at this first tap (never at launch).
import { getPermissionsAsync, presentContactPickerAsync, requestPermissionsAsync } from 'expo-contacts/legacy';
import { Platform } from 'react-native';

import type { ContactFields } from '@/engine/contact-parse';
import type { TranslationKey } from '@/i18n';

import { fieldsFromContact, type PickedContact } from './contact-map';

export type ContactPick = { status: 'ok'; fields: ContactFields } | { status: 'cancel' } | { status: 'error'; message: TranslationKey };

export async function pickContact(): Promise<ContactPick> {
  try {
    if (Platform.OS === 'android') {
      const current = await getPermissionsAsync();
      const granted = current.granted || (current.canAskAgain && (await requestPermissionsAsync()).granted);
      if (!granted) return { status: 'error', message: 'contacts.denied' };
    }
    const contact = await presentContactPickerAsync();
    if (!contact) return { status: 'cancel' };
    return { status: 'ok', fields: fieldsFromContact(contact as PickedContact) };
  } catch (error) {
    if (__DEV__) console.info('[contacts] picker failed:', String(error));
    return { status: 'error', message: 'contacts.failed' };
  }
}
