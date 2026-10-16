#!/usr/bin/env node
// Reads the commands.json of the Maestro flow .maestro/release/cold-start.yaml and prints, per round, the time of
// launchApp + extendedWaitUntil (kill -> Home button visible) and the median. Usage: node scripts/cold-start-times.mjs <run-dir>
import fs from 'node:fs';
const dir = process.argv[2];
const sub = fs.readdirSync(dir).find((x) => fs.statSync(`${dir}/${x}`).isDirectory());
const cmds = JSON.parse(fs.readFileSync(`${dir}/${sub}/commands.json`, 'utf8'));
const rounds = [];
let cur = 0;
for (const c of cmds) {
  const key = Object.keys(c.command)[0];
  const d = c.metadata?.duration ?? 0;
  if (key === 'launchAppCommand') cur = d;
  else if (key === 'extendedWaitUntilCommand' || key === 'assertConditionCommand') { rounds.push(cur + d); cur = 0; }
}
const sorted = [...rounds].sort((a, b) => a - b);
console.log('rounds (ms):', rounds.join(' '), '| median', sorted[Math.floor(sorted.length / 2)], 'ms');
