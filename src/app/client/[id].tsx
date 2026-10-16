import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Chip, ChipRow, Divider, ErrorText, Input, Row, Screen, Section } from '@/components/ui';
import { createClient, getClient, setClientArchived, updateClient, type ClientInput } from '@/db/clients';
import { listDocumentRows } from '@/db/list';
import { clientOverview } from '@/db/summary';
import { todayLocal } from '@/engine/dates';
import { useFormAutosave } from '@/hooks/use-form-autosave';
import { useLoader } from '@/hooks/use-loader';
import { dateLabel, money } from '@/lib/format';
import { CURRENCIES, parseDecimal } from '@/engine/money';
import { MAX_PAYMENT_DAYS } from '@/engine/status';
import { suggestTreatment, TREATMENTS, type Treatment } from '@/engine/treatment';
import { t } from '@/i18n';
import { getBusiness } from '@/db/business';
import { parseContactText, type ContactFields } from '@/engine/contact-parse';
import { applyProposal } from '@/lib/apply-proposal';
import { pick, recognizeLines } from '@/lib/capture';
import { pickContact } from '@/lib/contacts';
import { fixtureImage, isDevBuild } from '@/lib/debug';
import { errorText } from '@/lib/errors';

type Form = {
  kind: 'business' | 'person';
  name: string;
  contact: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  email: string;
  phone: string;
  vatId: string;
  buyerReference: string;
  treatment: Treatment;
  language: 'de' | 'en' | null;
  currency: string | null;
  paymentDays: string;
  notes: string;
  shipName: string;
  shipStreet: string;
  shipPostalCode: string;
  shipCity: string;
  shipCountryCode: string;
};

const EMPTY: Form = {
  kind: 'business', name: '', contact: '', street: '', postalCode: '', city: '', countryCode: 'DE', email: '', phone: '',
  vatId: '', buyerReference: '', treatment: 'standard', language: null, currency: null, paymentDays: '', notes: '',
  shipName: '', shipStreet: '', shipPostalCode: '', shipCity: '', shipCountryCode: '',
};

export default function ClientForm() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const isNew = id === 'new';
  const [form, setForm] = useState<Form>(EMPTY);
  const [archived, setArchived] = useState(false);
  const [loaded, setLoaded] = useState(isNew);
  const [triedSave, setTriedSave] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scan, setScan] = useState<{ message: string; lines: string[] } | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const { scanFixture } = useLocalSearchParams<{ scanFixture?: string }>();
  // The client this form writes to: the existing one, or the new one created by the first autosave (D84).
  const savedId = useRef<number | null>(isNew ? null : Number(id));

  useEffect(() => {
    if (isNew) return;
    getClient(db, Number(id)).then((c) => {
      if (!c) return;
      setForm({ ...c, paymentDays: c.paymentDays === null ? '' : String(c.paymentDays) });
      setArchived(c.archived);
      setLoaded(true);
    });
  }, [db, id, isNew]);

  // Existing client (SPEC §6 "Clients list/detail"): what is outstanding and every document of this client.
  const detail = useLoader(async (db) => {
    if (isNew) return null;
    const today = todayLocal();
    const [overview, rows] = await Promise.all([
      clientOverview(db, Number(id), today),
      listDocumentRows(db, ['invoice', 'cancellation', 'quote', 'receipt'], today, '', Number(id)),
    ]);
    return { overview, rows };
  });

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const suggestion = suggestTreatment(form);
  const daysParsed = form.paymentDays.trim() === '' ? null : parseDecimal(form.paymentDays, 'en', 0);
  const daysOk = daysParsed === null || (daysParsed.ok && daysParsed.value >= 0 && daysParsed.value <= MAX_PAYMENT_DAYS);
  const nameOk = form.name.trim() !== '';

  const payload: ClientInput | null =
    nameOk && daysOk
      ? {
          ...form,
          name: form.name.trim(),
          countryCode: form.countryCode.trim().toUpperCase() || 'DE',
          shipCountryCode: form.shipCountryCode.trim().toUpperCase(),
          paymentDays: daysParsed && daysParsed.ok ? daysParsed.value : null,
        }
      : null;
  // Autosave: typed input survives Back, a back-swipe and an app kill (SPEC §2, review #7).
  const autosave = useFormAutosave(
    payload,
    async (input) => {
      if (savedId.current === null) savedId.current = await createClient(db, input);
      else await updateClient(db, savedId.current, input);
    },
    loaded
  );

  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  function apply(fields: ContactFields, lines: string[]) {
    const r = applyProposal(formRef.current, fields);
    setForm(r.form);
    const message =
      r.filled === 0 && r.kept === 0 ? t('scan.nothing') : t('scan.filled', { n: r.filled }) + (r.kept ? ` ${t('scan.kept', { n: r.kept })}` : '');
    setScan({ message, lines });
  }

  async function fillFromImage(source: 'scan' | 'photos' | 'fixture') {
    if (scanBusy) return;
    setScanBusy(true);
    try {
      let uri: string | null = null;
      if (source === 'fixture') uri = await fixtureImage(scanFixture ?? 'card');
      else {
        const picked = await pick(source, 1);
        if (picked.status === 'cancel') return;
        if (picked.status === 'error') {
          setScan({ message: t(picked.message), lines: [] });
          return;
        }
        uri = picked.files[0]?.uri ?? null;
      }
      if (!uri) return;
      setScan({ message: t('scan.reading'), lines: [] });
      const lines = await recognizeLines(uri);
      const business = await getBusiness(db);
      const { fields } = parseContactText(lines, { own: { name: business.name, street: business.street, city: business.city, email: business.email } });
      apply(fields, lines);
    } catch (e) {
      setScan({ message: t('scan.failed', { error: errorText(e) }), lines: [] });
    } finally {
      setScanBusy(false);
    }
  }

  async function fillFromContacts() {
    if (scanBusy) return;
    setScanBusy(true);
    try {
      const picked = await pickContact();
      if (picked.status === 'cancel') return;
      if (picked.status === 'error') {
        setScan({ message: t(picked.message), lines: [] });
        return;
      }
      apply(picked.fields, []);
    } finally {
      setScanBusy(false);
    }
  }

  // Development builds: `?scanFixture=card` runs the real text recognition on a bundled card photo (Maestro).
  const fixtureRan = useRef(false);
  useEffect(() => {
    if (!isDevBuild || !scanFixture || !loaded || fixtureRan.current) return;
    fixtureRan.current = true;
    fillFromImage('fixture');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanFixture, loaded]);

  /** "Done": stores the last keystrokes (everything else is autosaved) and goes back. */
  async function save() {
    setTriedSave(true);
    if (!payload) return;
    if (await autosave.flush()) router.back();
    else setSaveError(t('form.notSaved'));
  }

  if (!loaded) return <Screen testID="client-form-loading">{null}</Screen>;
  return (
    <Screen testID="client-form">
      <Stack.Screen options={{ title: isNew ? t('clients.new') : form.name || t('clients.edit') }} />
      {detail.data ? (
        <Section title={t('client.outstanding')}>
          {detail.data.overview.outstanding.length === 0 ? (
            <Row testID="client-outstanding" title={t('client.nothingOpen')} />
          ) : (
            detail.data.overview.outstanding.map((o) => {
              const late = detail.data?.overview.overdue.find((x) => x.currency === o.currency);
              return (
                <Row
                  key={o.currency}
                  testID={`client-outstanding-${o.currency}`}
                  title={money(o.cents, o.currency)}
                  value={late ? `${money(late.cents, late.currency)} ${t('client.overdue')}` : undefined}
                />
              );
            })
          )}
        </Section>
      ) : null}
      <Section title={t('scan.title')} hint={t('scan.hint')}>
        <View style={{ padding: 16, paddingTop: 8, gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button testID="client-scan" variant="secondary" label={t('scan.card')} onPress={() => fillFromImage('scan')} disabled={scanBusy} />
            </View>
            <View style={{ flex: 1 }}>
              <Button testID="client-scan-photo" variant="secondary" label={t('scan.photo')} onPress={() => fillFromImage('photos')} disabled={scanBusy} />
            </View>
          </View>
          <Button testID="client-from-contacts" variant="secondary" label={t('scan.contacts')} onPress={fillFromContacts} disabled={scanBusy} />
          {scan ? (
            <View style={{ gap: 4 }}>
              <ThemedText type="small" testID="client-scan-result">{scan.message}</ThemedText>
              {scan.lines.length ? (
                <ThemedText type="small" themeColor="textSecondary" testID="client-scan-text">{`${t('scan.recognised')}\n${scan.lines.join('\n')}`}</ThemedText>
              ) : null}
            </View>
          ) : null}
        </View>
      </Section>
      <Section>
        <ChipRow>
          {(['business', 'person'] as const).map((k) => (
            <Chip key={k} testID={`client-kind-${k}`} label={t(`client.kind.${k}`)} selected={form.kind === k} onPress={() => set('kind', k)} />
          ))}
        </ChipRow>
        <Input label={t('client.name')} testID="client-name" value={form.name} onChangeText={(v) => set('name', v)} error={triedSave && !nameOk ? t('field.required') : null} />
        <Input label={t('client.contact')} testID="client-contact" value={form.contact} onChangeText={(v) => set('contact', v)} />
      </Section>
      <Section title={t('client.address')}>
        <Input label={t('field.street')} testID="client-street" value={form.street} onChangeText={(v) => set('street', v)} />
        <Input label={t('field.postalCode')} testID="client-postal" value={form.postalCode} onChangeText={(v) => set('postalCode', v)} />
        <Input label={t('field.city')} testID="client-city" value={form.city} onChangeText={(v) => set('city', v)} />
        <Input label={t('field.country')} testID="client-country" value={form.countryCode} autoCapitalize="characters" maxLength={2} onChangeText={(v) => set('countryCode', v)} />
      </Section>
      <Section title={t('client.shipTo')} hint={t('client.shipTo.hint')}>
        <Input label={t('client.shipName')} testID="client-ship-name" value={form.shipName} onChangeText={(v) => set('shipName', v)} />
        <Input label={t('field.street')} testID="client-ship-street" value={form.shipStreet} onChangeText={(v) => set('shipStreet', v)} />
        <Input label={t('field.postalCode')} testID="client-ship-postal" value={form.shipPostalCode} onChangeText={(v) => set('shipPostalCode', v)} />
        <Input label={t('field.city')} testID="client-ship-city" value={form.shipCity} onChangeText={(v) => set('shipCity', v)} />
        <Input label={t('field.country')} testID="client-ship-country" value={form.shipCountryCode} autoCapitalize="characters" maxLength={2} onChangeText={(v) => set('shipCountryCode', v)} />
      </Section>
      <Section title={t('client.contactDetails')}>
        <Input label={t('field.email')} testID="client-email" keyboardType="email-address" autoCapitalize="none" value={form.email} onChangeText={(v) => set('email', v)} />
        <Input label={t('field.phone')} testID="client-phone" keyboardType="phone-pad" value={form.phone} onChangeText={(v) => set('phone', v)} />
      </Section>
      <Section title={t('client.tax')} hint={t('client.treatment.hint')}>
        <Input label={t('field.vatId')} testID="client-vatid" autoCapitalize="characters" value={form.vatId} onChangeText={(v) => set('vatId', v)} />
        <Input label={t('field.buyerReference')} testID="client-buyer-ref" value={form.buyerReference} onChangeText={(v) => set('buyerReference', v)} />
        <ChipRow>
          {TREATMENTS.map((tr) => (
            <Chip key={tr} testID={`client-treatment-${tr}`} label={t(`treatment.${tr}`)} selected={form.treatment === tr} onPress={() => set('treatment', tr)} />
          ))}
        </ChipRow>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 4 }}>
          <ThemedText type="small" themeColor="textSecondary" testID="client-treatment-suggestion">
            {t(`treatment.suggest.${suggestion.reason}`)}
          </ThemedText>
          {suggestion.treatment && suggestion.treatment !== form.treatment ? (
            <Button testID="client-use-suggestion" variant="secondary" label={t('client.useSuggestion', { treatment: t(`treatment.${suggestion.treatment}`) })} onPress={() => set('treatment', suggestion.treatment as Treatment)} />
          ) : null}
        </View>
      </Section>
      <Section title={t('client.defaults')} hint={t('client.defaults.hint')}>
        <ChipRow>
          <Chip testID="client-lang-default" label={t('client.default')} selected={form.language === null} onPress={() => set('language', null)} />
          <Chip testID="client-lang-de" label="Deutsch" selected={form.language === 'de'} onPress={() => set('language', 'de')} />
          <Chip testID="client-lang-en" label="English" selected={form.language === 'en'} onPress={() => set('language', 'en')} />
        </ChipRow>
        <ChipRow>
          <Chip label={t('client.default')} selected={form.currency === null} onPress={() => set('currency', null)} />
          {CURRENCIES.slice(0, 6).map((c) => (
            <Chip key={c.code} label={c.code} selected={form.currency === c.code} onPress={() => set('currency', c.code)} />
          ))}
        </ChipRow>
        <Input label={t('field.paymentDays')} testID="client-payment-days" keyboardType="number-pad" value={form.paymentDays} placeholder={t('client.default')} onChangeText={(v) => set('paymentDays', v)} error={!daysOk ? t('field.invalidNumber') : null} />
        <Input label={t('client.notes')} testID="client-notes" multiline value={form.notes} onChangeText={(v) => set('notes', v)} />
      </Section>
      <ErrorText>{saveError}</ErrorText>
      <ThemedText type="small" themeColor="textSecondary" style={{ paddingHorizontal: 4 }}>{t('form.autosaved')}</ThemedText>
      <Button testID="client-save" label={t('action.done')} onPress={save} />
      {detail.data ? (
        <Section title={t('client.documents')}>
          {detail.data.rows.length === 0 ? (
            <Row title={t('client.noDocuments')} />
          ) : (
            detail.data.rows.map((r, i) => (
              <View key={r.id}>
                {i > 0 ? <Divider /> : null}
                <Row
                  testID={`client-doc-${r.id}`}
                  title={`${r.number ?? t('status.draft')} · ${t(`status.${r.derived.status}`)}`}
                  value={`${dateLabel(r.issueDate)} · ${money(r.grossCents, r.currency)}`}
                  onPress={() => router.push(r.status === 'draft' ? { pathname: '/document/[id]/edit', params: { id: String(r.id) } } : { pathname: '/document/[id]', params: { id: String(r.id) } })}
                />
              </View>
            ))
          )}
        </Section>
      ) : null}
      {!isNew ? (
        <Section>
          <Row
            testID="client-archive"
            title={archived ? t('client.unarchive') : t('client.archive')}
            onPress={async () => {
              await setClientArchived(db, Number(id), !archived);
              router.back();
            }}
          />
        </Section>
      ) : null}
    </Screen>
  );
}
