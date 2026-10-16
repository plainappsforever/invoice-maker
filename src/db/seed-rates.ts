// Factory tax rates (migration 2 seeds the same three rows; reset restores them).
export const TAX_RATE_SEEDS = [
  { label: '19 %', rateBp: 1900, isDefault: true },
  { label: '7 %', rateBp: 700, isDefault: false },
  { label: '0 %', rateBp: 0, isDefault: false },
] as const;
