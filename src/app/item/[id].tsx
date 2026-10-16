import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { Chip, ChipRow, ErrorText, Input, Row, Screen, Section, SwitchRow } from '@/components/ui';
import { listTaxRates, type TaxRate } from '@/db/business';
import { createCatalogItem, getCatalogItem, setCatalogItemArchived, UNIT_CODES, updateCatalogItem, type CatalogItemInput } from '@/db/items';
import { formatPercent, formatPrice, parsePriceE4 } from '@/engine/money';
import { ThemedText } from '@/components/themed-text';
import { useFormAutosave } from '@/hooks/use-form-autosave';
import { getUiLanguage, t } from '@/i18n';
import { ITEM_MAX_PX, pick, storedUri, storeImage } from '@/lib/capture';
import { fixtureImage, isDevBuild } from '@/lib/debug';
import { errorText } from '@/lib/errors';

export default function ItemForm() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const isNew = id === 'new';
  const lang = getUiLanguage();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState<string>('C62');
  const [price, setPrice] = useState('');
  const [includesVat, setIncludesVat] = useState(false);
  const [rateBp, setRateBp] = useState(1900);
  const [archived, setArchived] = useState(false);
  const [imageFile, setImageFile] = useState<string | null>(null);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [rates, setRates] = useState<TaxRate[]>([]);
  const [tried, setTried] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The item this form writes to: the existing one, or the new one created by the first autosave (D84).
  const savedId = useRef<number | null>(isNew ? null : Number(id));

  useEffect(() => {
    (async () => {
      const r = await listTaxRates(db);
      setRates(r);
      if (isNew) {
        setRateBp(r.find((x) => x.isDefault)?.rateBp ?? 1900);
      } else {
        const item = await getCatalogItem(db, Number(id));
        if (item) {
          setName(item.name);
          setDescription(item.description);
          setSku(item.sku);
          setUnit(item.unitCode);
          setPrice(formatPrice(item.priceE4, lang));
          setIncludesVat(item.priceIncludesVat);
          setRateBp(item.taxRateBp);
          setArchived(item.archived);
          setImageFile(item.imageFile);
        }
      }
      setLoaded(true);
    })();
  }, [db, id, isNew, lang]);

  const parsed = price.trim() === '' ? ({ ok: true, value: 0 } as const) : parsePriceE4(price, lang);
  const payload: CatalogItemInput | null =
    name.trim() && parsed.ok && parsed.value >= 0
      ? {
          name: name.trim(), description, sku, unitCode: unit, priceE4: parsed.value, priceIncludesVat: includesVat,
          taxCategory: rateBp === 0 ? 'Z' : 'S', taxRateBp: rateBp, imageFile,
        }
      : null;
  // Autosave: typed input survives Back, a back-swipe and an app kill (SPEC §2, review #7).
  const autosave = useFormAutosave(
    payload,
    async (input) => {
      if (savedId.current === null) savedId.current = await createCatalogItem(db, input);
      else await updateCatalogItem(db, savedId.current, input);
    },
    loaded
  );

  /** Product photo (V1.5 P1, L153-a): downscaled to 800 px and stored; a replaced photo file stays (issued documents may print it). */
  async function photo(source: 'camera' | 'photos' | 'fixture') {
    setPhotoMessage(null);
    try {
      let uri: string | null = null;
      if (source === 'fixture') uri = await fixtureImage('item');
      else {
        const picked = await pick(source, 1);
        if (picked.status === 'cancel') return;
        if (picked.status === 'error') {
          setPhotoMessage(t(picked.message));
          return;
        }
        uri = picked.files[0]?.uri ?? null;
      }
      if (!uri) return;
      const stored = await storeImage(uri, 'items', ITEM_MAX_PX);
      setImageFile(stored.file);
    } catch (e) {
      setPhotoMessage(errorText(e));
    }
  }

  /** "Done": stores the last keystrokes (everything else is autosaved) and goes back. */
  async function save() {
    setTried(true);
    if (!payload) return;
    if (await autosave.flush()) router.back();
    else setSaveError(t('form.notSaved'));
  }

  if (!loaded) return <Screen testID="item-form-loading">{null}</Screen>;
  return (
    <Screen testID="item-form">
      <Stack.Screen options={{ title: isNew ? t('items.new') : name || t('items.edit') }} />
      <Section>
        <Input label={t('item.name')} testID="item-name" value={name} onChangeText={setName} error={tried && !name.trim() ? t('field.required') : null} />
        <Input label={t('item.description')} testID="item-description" multiline maxLength={1500} value={description} onChangeText={setDescription} />
        <Input label={t('item.sku')} testID="item-sku" value={sku} onChangeText={setSku} autoCapitalize="characters" />
      </Section>
      <Section title={t('item.photo')} hint={t('item.photo.hint')}>
        <View style={{ padding: 16, paddingTop: 8, gap: 8, alignItems: 'flex-start' }}>
          {imageFile && storedUri(imageFile) ? (
            <Image testID="item-photo-image" source={{ uri: storedUri(imageFile) as string }} style={{ width: 120, height: 120, borderRadius: 8 }} contentFit="cover" />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button testID="item-photo-camera" variant="secondary" label={t('item.photo.camera')} onPress={() => photo('camera')} />
            <Button testID="item-photo-pick" variant="secondary" label={t('item.photo.pick')} onPress={() => photo('photos')} />
          </View>
          {imageFile ? <Button testID="item-photo-remove" variant="secondary" label={t('item.photo.remove')} onPress={() => setImageFile(null)} /> : null}
          {isDevBuild ? <Button testID="item-photo-sample" variant="secondary" label="Sample photo (dev)" onPress={() => photo('fixture')} /> : null}
          {photoMessage ? <ThemedText type="small" testID="item-photo-message">{photoMessage}</ThemedText> : null}
        </View>
      </Section>
      <Section title={t('item.unit')}>
        <ChipRow>
          {UNIT_CODES.map((u) => (
            <Chip key={u} testID={`item-unit-${u}`} label={t(`render.unit.${u}`)} selected={unit === u} onPress={() => setUnit(u)} />
          ))}
        </ChipRow>
      </Section>
      <Section title={t('item.price')}>
        <Input label={t('item.unitPrice')} testID="item-price" keyboardType="decimal-pad" value={price} onChangeText={setPrice} error={tried && !parsed.ok ? t('field.invalidNumber') : null} />
        <SwitchRow testID="item-includes-vat" label={t('item.includesVat')} value={includesVat} onValueChange={setIncludesVat} />
        <ChipRow>
          {rates.map((r) => (
            <Chip key={r.id} testID={`item-rate-${r.rateBp}`} label={`${formatPercent(r.rateBp, lang)} %`} selected={rateBp === r.rateBp} onPress={() => setRateBp(r.rateBp)} />
          ))}
        </ChipRow>
      </Section>
      <ErrorText>{saveError}</ErrorText>
      <ThemedText type="small" themeColor="textSecondary" style={{ paddingHorizontal: 4 }}>{t('form.autosaved')}</ThemedText>
      <Button testID="item-save" label={t('action.done')} onPress={save} />
      {!isNew ? (
        <Section>
          <Row
            testID="item-archive"
            title={archived ? t('item.unarchive') : t('item.archive')}
            onPress={async () => {
              await setCatalogItemArchived(db, Number(id), !archived);
              router.back();
            }}
          />
        </Section>
      ) : null}
    </Screen>
  );
}
