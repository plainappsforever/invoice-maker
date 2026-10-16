// V1_PLAN rule 13: Jest runs in German local time (set by test/global-setup.js).
it('runs with TZ=Europe/Berlin (CEST in summer, CET in winter)', () => {
  expect(process.env.TZ).toBe('Europe/Berlin');
  expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(-120);
  expect(new Date(2026, 11, 1).getTimezoneOffset()).toBe(-60);
});
