import { useCallback, useEffect, useRef } from 'react';

import { AUTOSAVE_MS } from '@/components/ui';

/**
 * Autosave for a whole form (line, client, item; v1.1 D84, review #7, SPEC §2 "leaving never loses data").
 * `payload` is the value to store, or null while the form is not valid (nothing is saved then, as for a single
 * field, D61). It is written 400 ms after the last change, when the screen goes away (back button, back-swipe)
 * and on `flush()` (the Done button). Saves run one after another, so a new record is created only once.
 * `ready` = the stored values are loaded: the first payload after that is the baseline and is not written again.
 */
export function useFormAutosave<T>(payload: T | null, persist: (value: T) => Promise<void>, ready: boolean) {
  const key = payload === null ? null : JSON.stringify(payload);
  const latest = useRef({ payload, key, persist });
  useEffect(() => {
    latest.current = { payload, key, persist };
  });
  const lastSaved = useRef<string | null>(null);
  const baselined = useRef(false);
  const stopped = useRef(false);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => {
    if (ready && !baselined.current) {
      baselined.current = true;
      lastSaved.current = key;
    }
  }, [ready, key]);

  /** Saves the current payload if it changed; resolves true when what the form shows is stored. */
  const flush = useCallback((): Promise<boolean> => {
    chain.current = chain.current
      .catch(() => false)
      .then(async () => {
        const { payload: value, key: k, persist: save } = latest.current;
        if (stopped.current || !baselined.current) return true;
        if (value === null) return false;
        if (k === lastSaved.current) return true;
        try {
          await save(value);
          lastSaved.current = k;
          return true;
        } catch (e) {
          // e.g. the draft was issued meanwhile; the next change or the Done button tries again
          if (__DEV__) console.warn('form autosave failed', e);
          return false;
        }
      });
    return chain.current;
  }, []);

  useEffect(() => {
    if (key === null || !ready) return;
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [key, ready, flush]);

  useEffect(
    () => () => {
      void flush(); // leaving the screen never loses typed input
    },
    [flush]
  );

  /** After "Delete" / "Archive" nothing more is written. */
  const stop = useCallback(() => {
    stopped.current = true;
  }, []);

  return { flush, stop };
}
