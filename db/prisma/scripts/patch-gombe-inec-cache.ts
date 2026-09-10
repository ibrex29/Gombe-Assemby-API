import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGombeInecAlignment, type JayCodistStateFile } from '../gombe-inec-alignment';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CACHE_PATH = resolve(__dirname, '../seed-data/cache/gombe.json');

function countPus(payload: JayCodistStateFile): number {
  return (payload.state?.lgas ?? []).reduce(
    (sum, lga) => sum + lga.wards.reduce((wardSum, ward) => wardSum + ward.pollingUnits.length, 0),
    0,
  );
}

function hasDelimitation(payload: JayCodistStateFile, delimitation: string): boolean {
  for (const lga of payload.state?.lgas ?? []) {
    for (const ward of lga.wards) {
      if (ward.pollingUnits.some((pu) => pu.delimitation === delimitation)) return true;
    }
  }
  return false;
}

function main() {
  const before = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as JayCodistStateFile;
  const beforeCount = countPus(before);
  const aligned = applyGombeInecAlignment(structuredClone(before));
  const afterCount = countPus(aligned);

  writeFileSync(CACHE_PATH, `${JSON.stringify(aligned)}\n`);

  const checks = [
    '15/04/10/025',
    '15/07/03/032',
    '15/10/10/012',
    '15/10/10/017',
  ] as const;
  const removed = ['15/04/09/025', '15/10/09/015'] as const;

  console.log(`Patched ${CACHE_PATH}`);
  console.log(`  PUs: ${beforeCount} → ${afterCount}`);
  for (const code of checks) {
    console.log(`  ${code}: ${hasDelimitation(aligned, code) ? 'ok' : 'MISSING'}`);
  }
  for (const code of removed) {
    console.log(`  removed ${code}: ${hasDelimitation(aligned, code) ? 'STILL PRESENT' : 'ok'}`);
  }
}

main();
