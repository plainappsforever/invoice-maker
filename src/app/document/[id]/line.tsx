import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Chip, ChipRow, ErrorText, Input, Screen, Section, SwitchRow } from '@/components/ui';
import { getBusiness } from '@/db/business';
import { listTaxRates, type TaxRate } from '@/db/business';
import { getDocument, type Document } from '@/db/documents';
import { deleteDraftLine, saveDraftLine } from '@/db/editing';
import { createCatalogItem, listCatalogItems, UNIT_CODES, type CatalogItem } from '@/db/items';
import { listLines } from '@/db/lines';
import { formatDecimal, formatPercent, formatPrice, formatQty, parseBp, parseCents, parsePriceE4, parseQtyMilli, roundDiv } from '@/engine/money';
import type { DiscountKind } from '@/engine/totals';
import { treatmentCategory } from '@/engine/treatment';
import { useFormAutosave } from '@/hooks/use-form-autosave';
import { getUiLanguage, t } from '@/i18n';
import { errorText } from '@/lib/errors';
import { unitLabel } from '@/lib/format';
import { useSQLiteContext } from 'expo-sqlite';

/** One line of a draft: name (with catalog suggestions), quantity, unit, price, VAT rate, discount, description. */
export default function LineForm() {
  const { id, lineId } = useLocalSearchParams<{ id: string; lineId: string }>();
  const docId = Number(id);
  const isNew = lineId === 'new';
  const db = useSQLiteContext();
  const router = useRouter();
  const lang = getUiLanguage();
  const [doc, setDoc] = useState<Document | null>(null);
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [vatLocked, setVatLocked] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState<string>('C62');
  const [price, setPrice] = useState('');
  const [rateBp, setRateBp] = useState(1900);
  const [discKind, setDiscKind] = useState<DiscountKind>('none');
  const [discValue, setDiscValue] = useState('');
  const [catalogId, setCatalogId] = useState<number | null>(null);
  const [saveToCatalog, setSaveToCatalog] = useState(false);
  const [suggestions, setSuggestions] = useState<CatalogItem[]>([]);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The line this form writes to: the existing one, or the new one created by the first autosave (D84).
  const savedId = useRef<number | null>(isNew ? null : Number(lineId));
  const [savedLineId, setSavedLineId] = useState<number | null>(savedId.current);
  const catalogSaved = useRef(false);

  useEffect(() => {
    (async () => {
      const d = await getDocument(db, docId);
      const business = await getBusiness(db);
      const r = await listTaxRates(db);
      setDoc(d);
      setRates(r);
      if (d) setVatLocked(treatmentCategory(d.treatment, business.vatMode) !== null);
      if (isNew) {
        setRateBp(r.find((x) => x.isDefault)?.rateBp ?? 1900);
      } else {
        const l = (await listLines(db, docId)).find((x) => x.id === Number(lineId));
        if (l) {
          setName(l.name);
          setDescription(l.description);
          setQty(formatQty(l.qtyMilli, lang));
          setUnit(l.unitCode);
          setPrice(formatPrice(l.priceE4, lang));
          setRateBp(l.taxRateBp);
          setDiscKind(l.discountKind);
          setDiscValue(l.discountKind === 'none' ? '' : l.discountKind === 'percent' ? formatPercent(l.discountValue, lang) : formatDecimal(l.discountValue, 2, lang, 2));
          setCatalogId(l.catalogItemId);
        }
      }
      setLoaded(true);
    })();
  }, [db, docId, lineId, isNew, lang]);

  // Catalog suggestions while typing a new line's name (F3 "catalog search").
  const query = isNew && catalogId === null ? name.trim() : '';
  useEffect(() => {
    if (!query) return;
    let active = true;
    listCatalogItems(db, { search: query }).then((r) => active && setSuggestions(r.slice(0, 4)));
    return () => {
      active = false;
    };
  }, [db, query]);

  const qtyP = parseQtyMilli(qty, lang);
  const priceP = parsePriceE4(price.trim() === '' ? '0' : price, lang);
  const discP = discKind === 'none' ? ({ ok: true, value: 0 } as const) : discKind === 'percent' ? parseBp(discValue, lang) : parseCents(discValue, lang);
  const valid = name.trim() !== '' && qtyP.ok && qtyP.value !== 0 && priceP.ok && priceP.value >= 0 && discP.ok && discP.value >= 0 && (discKind !== 'percent' || (discP.ok && discP.value <= 10_000));
  const payload =
    valid && qtyP.ok && priceP.ok && discP.ok
      ? {
          name: name.trim(), description, qtyMilli: qtyP.value, unitCode: unit, priceE4: priceP.value, rateBp,
          discountKind: discKind, discountValue: discKind === 'none' ? 0 : discP.value, catalogItemId: catalogId,
        }
      : null;
  const saveToCatalogRef = useRef(saveToCatalog);
  useEffect(() => {
    saveToCatalogRef.current = saveToCatalog;
  });
  // Autosave into the draft: typed input survives Back, a back-swipe and an app kill (SPEC §2, review #7).
  const autosave = useFormAutosave(
    payload,
    async (form) => {
      const id = await saveDraftLine(db, docId, savedId.current, form);
      savedId.current = id;
      setSavedLineId(id);
      if (saveToCatalogRef.current && !catalogSaved.current) await addToCatalog(form);
    },
    loaded && doc !== null && doc.status === 'draft'
  );

  async function addToCatalog(form: NonNullable<typeof payload>) {
    catalogSaved.current = true;
    await createCatalogItem(db, {
      name: form.name, description: form.description, unitCode: form.unitCode, priceE4: form.priceE4, priceIncludesVat: doc!.pricesIncludeVat,
      taxCategory: form.rateBp === 0 ? 'Z' : 'S', taxRateBp: form.rateBp,
    });
  }

  if (!doc) return <Screen testID="line-loading">{null}</Screen>;

  function pick(item: CatalogItem) {
    setName(item.name);
    setDescription(item.description);
    setUnit(item.unitCode);
    setCatalogId(item.id);
    setRateBp(item.taxCategory === 'S' || item.taxCategory === 'Z' ? item.taxRateBp : 0);
    let p = item.priceE4;
    const rate = item.taxCategory === 'S' ? item.taxRateBp : 0;
    if (rate > 0 && item.priceIncludesVat && !doc!.pricesIncludeVat) p = roundDiv(p * 10_000, 10_000 + rate);
    if (rate > 0 && !item.priceIncludesVat && doc!.pricesIncludeVat) p = roundDiv(p * (10_000 + rate), 10_000);
    setPrice(formatPrice(p, lang));
    setSuggestions([]);
  }

  /** "Done": everything is autosaved already; this stores the last keystrokes and the catalog copy, then goes back. */
  async function save() {
    setTried(true);
    if (!payload) return;
    try {
      if (!(await autosave.flush())) throw new Error(t('form.notSaved'));
      if (saveToCatalog && !catalogSaved.current) await addToCatalog(payload);
      router.back();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Screen testID="line-form">
      <Stack.Screen options={{ title: isNew ? t('editor.addLine') : t('line.edit') }} />
      <Section>
        <Input label={t('line.name')} testID="line-name" value={name} onChangeText={(v) => { setName(v); setCatalogId(null); }} error={tried && !name.trim() ? t('field.required') : null} />
        {(query ? suggestions : []).map((s) => (
          <Pressable key={s.id} testID={`suggest-${s.id}`} accessibilityRole="button" onPress={() => pick(s)} style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
            <ThemedText type="smallBold" themeColor="tint">{t('line.useItem', { name: s.name, price: formatPrice(s.priceE4, lang) })}</ThemedText>
          </Pressable>
        ))}
      </Section>
      <Section>
        <Input label={t('line.quantity')} testID="line-qty" keyboardType="decimal-pad" value={qty} onChangeText={setQty} error={tried && !(qtyP.ok && qtyP.value !== 0) ? t('field.invalidNumber') : null} />
        <Input label={doc.pricesIncludeVat ? t('line.priceGross') : t('line.priceNet')} testID="line-price" keyboardType="decimal-pad" value={price} onChangeText={setPrice} error={tried && !(priceP.ok && priceP.value >= 0) ? t('field.invalidNumber') : null} />
        <ChipRow>
          {UNIT_CODES.map((u) => (
            <Chip key={u} testID={`line-unit-${u}`} label={unitLabel(u)} selected={unit === u} onPress={() => setUnit(u)} />
          ))}
        </ChipRow>
      </Section>
      <Section title={t('line.vat')} hint={vatLocked ? t('line.vatLocked') : undefined}>
        {vatLocked ? null : (
          <ChipRow>
            {rates.map((r) => (
              <Chip key={r.id} testID={`line-rate-${r.rateBp}`} label={`${formatPercent(r.rateBp, lang)} %`} selected={rateBp === r.rateBp} onPress={() => setRateBp(r.rateBp)} />
            ))}
          </ChipRow>
        )}
      </Section>
      <Section title={t('line.discount')}>
        <ChipRow>
          {(['none', 'percent', 'amount'] as DiscountKind[]).map((k) => (
            <Chip key={k} testID={`line-discount-${k}`} label={t(`editor.discount.${k}`)} selected={discKind === k} onPress={() => { setDiscKind(k); setDiscValue(''); }} />
          ))}
        </ChipRow>
        {discKind !== 'none' ? (
          <Input label={discKind === 'percent' ? t('editor.discount.percentValue') : t('editor.discount.amountValue')} testID="line-discount-value" keyboardType="decimal-pad" value={discValue} onChangeText={setDiscValue} error={tried && !(discP.ok && discP.value >= 0) ? t('field.invalidNumber') : null} />
        ) : null}
      </Section>
      <Section>
        <Input label={t('line.description')} testID="line-description" multiline maxLength={1500} value={description} onChangeText={setDescription} />
      </Section>
      {isNew ? (
        <Section>
          <SwitchRow testID="line-save-to-items" label={t('line.saveToItems')} value={saveToCatalog} onValueChange={setSaveToCatalog} />
        </Section>
      ) : null}
      <ErrorText>{error}</ErrorText>
      <ThemedText type="small" themeColor="textSecondary" style={{ paddingHorizontal: 4 }}>{t('form.autosaved')}</ThemedText>
      <Button testID="line-save" label={t('action.done')} onPress={save} />
      {savedLineId !== null ? (
        <View>
          <Button
            testID="line-delete"
            variant="secondary"
            label={t('line.delete')}
            onPress={async () => {
              autosave.stop();
              await autosave.flush(); // let a running save finish, so the line it created is the one deleted
              if (savedId.current !== null) await deleteDraftLine(db, savedId.current);
              router.back();
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}
