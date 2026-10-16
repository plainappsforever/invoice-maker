// One hook for "the data changed": every committed write unit (src/db/transaction.ts) calls `afterDataChange()` once
// it is done. The app registers the reminder re-plan here (src/lib/reminders.ts, P6); tests register nothing.
type Listener = () => void;

const listeners = new Set<Listener>();

export function onDataChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function afterDataChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a listener must never break a write that already committed
    }
  }
}
