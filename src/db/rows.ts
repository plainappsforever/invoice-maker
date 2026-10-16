// Row mapping helpers: snake_case columns ↔ camelCase fields, 0/1 ↔ boolean for the listed flags.
// Only whitelisted field names ever reach SQL text (no injection through patch keys).
export type BindValue = string | number | null;

export const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const toCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function fromRow<T>(row: Record<string, unknown>, booleans: readonly string[] = []): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const field = toCamel(key);
    out[field] = booleans.includes(field) ? value === 1 : value;
  }
  return out as T;
}

function toValue(value: unknown): BindValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value as BindValue;
}

/** Columns + placeholders + values for the given fields (only those in `allowed`). */
export function assignments(patch: Record<string, unknown>, allowed: readonly string[]) {
  const fields = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const unknown = fields.filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`unknown or read-only fields: ${unknown.join(', ')}`);
  return {
    columns: fields.map(toSnake),
    values: fields.map((k) => toValue(patch[k])),
  };
}

export function insertSql(table: string, patch: Record<string, unknown>, allowed: readonly string[]) {
  const { columns, values } = assignments(patch, allowed);
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  };
}

/** UPDATE … SET a = ?, b = ? WHERE id = ?; returns null when the patch is empty. */
export function updateSql(table: string, id: number, patch: Record<string, unknown>, allowed: readonly string[]) {
  const { columns, values } = assignments(patch, allowed);
  if (columns.length === 0) return null;
  return { sql: `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, values: [...values, id] };
}
