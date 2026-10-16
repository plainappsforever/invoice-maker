#!/usr/bin/env node
// Review "tests to add" #10 / kit 1c items 6, 12, 21: the store variants' Info.plist (expo config --type introspect, no files
// written) has the export-compliance key, the 1.1.0 / 10100 versions and no dev-client residue; the development variant
// still has its dev-client scheme. Usage: node scripts/check-store-config.mjs  (exit 1 on a problem)
import { execFileSync } from 'node:child_process';

const plist = (variant) => {
  const out = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
    env: { ...process.env, APP_VARIANT: variant }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out).ios.infoPlist ?? {};
};
const problems = [];
for (const variant of ['preview', 'production']) {
  const p = plist(variant);
  const schemes = (p.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
  const check = (ok, what) => { if (!ok) problems.push(`${variant}: ${what}`); };
  check(p.ITSAppUsesNonExemptEncryption === false, 'ITSAppUsesNonExemptEncryption is not false');
  check(p.CFBundleShortVersionString === '1.1.0' && String(p.CFBundleVersion) === '10100', `versions ${p.CFBundleShortVersionString} / ${p.CFBundleVersion}`);
  check(p.NSLocalNetworkUsageDescription === undefined, 'NSLocalNetworkUsageDescription present');
  check(!(p.NSBonjourServices ?? []).includes('_expo._tcp'), '_expo._tcp Bonjour service present');
  check(!schemes.some((s) => s.startsWith('exp+')), `dev scheme present (${schemes.join(', ')})`);
  check(!Object.keys(p).some((k) => k.startsWith('EXDevMenu')), 'EXDevMenu* keys present');
  check(!p.NSAppTransportSecurity?.NSAllowsLocalNetworking, 'NSAllowsLocalNetworking present');
  console.log(`${variant}: schemes ${schemes.join(', ')}; ${p.CFBundleShortVersionString} (${p.CFBundleVersion}); encryption key ${p.ITSAppUsesNonExemptEncryption}`);
}
const dev = plist('development');
if (!(dev.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []).some((s) => s.startsWith('exp+'))) problems.push('development: the dev-client scheme is missing');
if (problems.length) {
  console.error(`PROBLEMS:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('store config OK');
