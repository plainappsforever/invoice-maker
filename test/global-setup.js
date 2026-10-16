// Jest runs every test in German local time (V1_PLAN rule 13): dates like "today" and due dates are
// local calendar days. Set here (before workers start) so `npx jest <path>` gets it too.
module.exports = () => {
  process.env.TZ = 'Europe/Berlin';
};
