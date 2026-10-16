import { useFocusEffect } from 'expo-router';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data from the database when the screen mounts, whenever it comes back into focus and when `key` changes
 * (search text …). `reload()` after a write. A slower, older load never overwrites a newer one.
 */
export function useLoader<T>(load: (db: SQLiteDatabase) => Promise<T>, key: string | number = '') {
  const db = useSQLiteContext();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    try {
      const value = await loadRef.current(db);
      if (n === seq.current) {
        setData(value);
        setError(null);
      }
    } catch (e) {
      if (__DEV__) console.warn('useLoader: load failed', e);
      if (n === seq.current) setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [db]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload])
  );
  useEffect(() => {
    void reload();
  }, [key, reload]);
  return { data, error, reload, db };
}
