/**
 * @jest-environment node
 */
// expo-sqlite hands every openDatabaseAsync('app.db') the SAME native connection but a new JS object; a queue per JS
// object let a background handle BEGIN inside the UI handle's transaction ("cannot start a transaction within a
// transaction"; warranty-wallet D110). The queue is keyed by database file.
import { createTestDb } from '../../test/node-sqlite-db';

import { LATEST_VERSION, migrate } from './migrations';
import { getSetting, setSetting } from './settings';
import { exclusive, withTransaction } from './transaction';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function twoHandles() {
  const ui = Object.assign(createTestDb(), { databasePath: '/data/files/SQLite/app.db' });
  const background = { ...ui }; // another JS object on the same connection, as openDatabaseAsync returns
  return { ui, background };
}

describe('one write queue per database file', () => {
  it('two JS handles on one file share one queue (no write joins or breaks the other handle\'s transaction)', async () => {
    const { ui, background } = twoHandles();
    await migrate(ui);
    const failing = withTransaction(ui, async (tx) => {
      await setSetting(tx, 'inside', '1');
      await tick();
      throw new Error('boom');
    });
    const other = tick().then(() => exclusive(background, (w) => setSetting(w, 'outside', '1'))); // during the unit
    await expect(failing).rejects.toThrow('boom');
    await other;
    expect(await exclusive(ui, (r) => getSetting(r, 'inside'))).toBeNull();
    expect(await exclusive(background, (r) => getSetting(r, 'outside'))).toBe('1');
  });

  it('two JS handles migrate at the same cold start without a nested BEGIN, each migration once', async () => {
    const { ui, background } = twoHandles();
    await Promise.all([migrate(background), migrate(ui)]);
    const row = await ui.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(LATEST_VERSION);
    await ui.execAsync('BEGIN; COMMIT;'); // no transaction left open
  });
});
