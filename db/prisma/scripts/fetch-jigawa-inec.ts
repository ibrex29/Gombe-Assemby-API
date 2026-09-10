import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const OUT_DIR = resolve(__dirname, '../seed-data');
const STATE_URL =
  'https://raw.githubusercontent.com/JayCodist/inec-polling-units-scraper/main/results/jigawa.json';

interface JayCodistPu {
  delimitation?: string;
  name: string;
  remark?: string;
  state: string;
  lga: string;
  ward: string;
  units: string;
}

interface JayCodistWard {
  name: string;
  abbreviation?: string;
  pollingUnits: JayCodistPu[];
}

interface JayCodistLga {
  name: string;
  abbreviation: string;
  wards: JayCodistWard[];
}

interface JayCodistStateFile {
  state: { code: string; name: string; lgas: JayCodistLga[] };
  metadata?: Record<string, unknown>;
}

function delimitationToCode(delimitation: string): string {
  return delimitation.replace(/\//g, '-');
}

function buildPuCode(pu: JayCodistPu, stateCode: string, lgaCode: string): string {
  if (pu.delimitation) {
    return delimitationToCode(pu.delimitation);
  }

  return `${stateCode}-${lgaCode}-${pu.ward}-${pu.units}`;
}

function toSeedLgaFile(stateCode: string, lga: JayCodistLga) {
  const delimiterPrefix = `${stateCode}-${lga.abbreviation}`;
  let existingPuCount = 0;
  let newPuCount = 0;

  const wards = lga.wards.map((ward) => {
    const pollingUnitsRaw = ward.pollingUnits.filter((pu) => pu.name && (pu.delimitation || pu.units));
    const firstPu = pollingUnitsRaw[0];
    const wardCode = firstPu?.ward ?? ward.abbreviation ?? '01';
    const registrationAreaCode = `${stateCode}-${lga.abbreviation}-${wardCode}`;

    const pollingUnits = pollingUnitsRaw.map((pu) => {
      if (pu.remark === 'NEW PU') newPuCount += 1;
      else existingPuCount += 1;

      return {
        code: buildPuCode(pu, stateCode, lga.abbreviation),
        name: pu.name,
        remark: pu.remark ?? 'EXISTING PU',
      };
    });

    return {
      name: ward.name,
      inecCode: wardCode,
      registrationAreaCode,
      pollingUnits,
    };
  });

  const pollingUnitCount = wards.reduce((sum, ward) => sum + ward.pollingUnits.length, 0);

  return {
    source: 'INEC Polling Unit Portal (via JayCodist/inec-polling-units-scraper)',
    extractedAt: new Date().toISOString().slice(0, 10),
    state: {
      name: 'Jigawa',
      code: 'JI',
      inecCode: stateCode,
    },
    lga: {
      name: lga.name,
      inecCode: lga.abbreviation,
      delimiterPrefix,
    },
    wards,
    summary: {
      wardCount: wards.length,
      pollingUnitCount,
      existingPuCount,
      newPuCount,
    },
  };
}

async function main() {
  console.log(`Fetching Jigawa INEC data from ${STATE_URL}...`);
  const response = await fetch(STATE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Jigawa INEC data: ${response.status}`);
  }

  const payload = (await response.json()) as JayCodistStateFile;
  mkdirSync(OUT_DIR, { recursive: true });

  const statePath = resolve(OUT_DIR, 'jigawa-inec-state.json');
  writeFileSync(statePath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${statePath}`);

  for (const lga of payload.state.lgas) {
    const slug = lga.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const lgaPath = resolve(OUT_DIR, `jigawa-${slug}-inec.json`);
    const seedFile = toSeedLgaFile(payload.state.code, lga);
    writeFileSync(lgaPath, JSON.stringify(seedFile, null, 2));
    console.log(
      `  ${seedFile.lga.name}: ${seedFile.summary.wardCount} wards, ${seedFile.summary.pollingUnitCount} PUs`,
    );
  }

  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
