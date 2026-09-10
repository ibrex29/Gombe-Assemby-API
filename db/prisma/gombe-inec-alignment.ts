/**
 * Corrections so Gombe polling units match INEC delimitations (gov race 6407d9bf…).
 * JayCodist mis-names some Lalaipido PUs, omits Lapan/Kaltungo/Zange units, and
 * duplicates Lapan PUs under wrong Lalaipido codes (015–017 only).
 */

export interface JayCodistPu {
  delimitation?: string;
  name: string;
  remark?: string;
  state?: string;
  lga?: string;
  ward?: string;
  units?: string;
  abbreviation?: string;
  id?: string;
  registration_area_id?: string;
  precise_location?: null | string;
}

export interface JayCodistWard {
  name: string;
  abbreviation?: string;
  pollingUnits: JayCodistPu[];
}

export interface JayCodistLga {
  name: string;
  abbreviation: string;
  wards: JayCodistWard[];
}

export interface JayCodistStateFile {
  state: { code: string; name: string; lgas: JayCodistLga[] };
}

const INEC_PU_NAMES: Record<string, string> = {
  '15/04/10/025': 'Kobini Zange, Zange Prim. School I',
  '15/07/03/032': 'Nasarawa/H/Prim. School',
  '15/10/09/013': 'SHAGU PRI. SCH. II',
  '15/10/09/014': 'LALATAR, LALATAR PRI. SCH II',
  '15/10/10/012': 'Mango III, Lapan Prim. School',
  '15/10/10/013': 'Mango IV, Lapan Prim. School',
  '15/10/10/014': 'Primary Health Care Kwalkwari',
  '15/10/10/015': 'Lantame Primary School',
  '15/10/10/016': 'Govt. Sec. Sch, Lapan Kalaku',
  '15/10/10/017': 'Lasanjang Prim. Sch. II',
};

/** JayCodist duplicated these Lapan units under Lalaipido — INEC only lists them under Lapan. */
const REMOVE_LALAIPIDO_DELIMITATIONS = new Set(['15/10/09/015', '15/10/09/016', '15/10/09/017']);

function findWard(lgas: JayCodistLga[], lgaName: string, wardName: string): JayCodistWard | null {
  const lga = lgas.find((row) => row.name === lgaName);
  if (!lga) return null;
  return lga.wards.find((ward) => ward.name === wardName) ?? null;
}

function clonePuTemplate(pu: JayCodistPu, delimitation: string, name: string): JayCodistPu {
  const [, state = '15', lga = '00', ward = '00', units = '000'] = delimitation.split('/');
  return {
    ...pu,
    id: `inec-align-${delimitation.replace(/\//g, '-')}`,
    name,
    state,
    lga,
    ward,
    units,
    abbreviation: units,
    delimitation,
    remark: pu.remark ?? 'NEW PU',
    precise_location: pu.precise_location ?? null,
  };
}

function upsertPu(ward: JayCodistWard, template: JayCodistPu, delimitation: string, name: string) {
  const next = clonePuTemplate(template, delimitation, name);
  const index = ward.pollingUnits.findIndex((pu) => pu.delimitation === delimitation);
  if (index >= 0) {
    ward.pollingUnits[index] = { ...ward.pollingUnits[index], ...next };
    return;
  }
  ward.pollingUnits.push(next);
  ward.pollingUnits.sort((a, b) => (a.delimitation ?? '').localeCompare(b.delimitation ?? ''));
}

/** Apply INEC-aligned Gombe PU corrections to a JayCodist state payload. */
export function applyGombeInecAlignment(payload: JayCodistStateFile): JayCodistStateFile {
  const lgas = payload.state?.lgas;
  if (!lgas?.length) return payload;

  const wuroTale = findWard(lgas, 'DUKKU', 'WURO TALE');
  const zange = findWard(lgas, 'DUKKU', 'ZANGE');
  const kaltungoWest = findWard(lgas, 'KALTUNGO', 'KALTUNGO WEST');
  const lalaipido = findWard(lgas, 'SHONGOM', 'LALAIPIDO');
  const lapan = findWard(lgas, 'SHONGOM', 'LAPAN');

  const movedZange =
    wuroTale?.pollingUnits.find((pu) => pu.delimitation === '15/04/09/025') ??
    zange?.pollingUnits.find((pu) => pu.delimitation === '15/04/10/025');

  const misplacedLapanFromLalaipido = new Map<string, JayCodistPu>();
  if (lalaipido) {
    for (const units of ['015', '016', '017'] as const) {
      const pu = lalaipido.pollingUnits.find((row) => row.delimitation === `15/10/09/${units}`);
      if (pu) misplacedLapanFromLalaipido.set(units, pu);
    }
  }

  if (wuroTale) {
    wuroTale.pollingUnits = wuroTale.pollingUnits.filter(
      (pu) => pu.delimitation !== '15/04/09/025',
    );
  }

  if (lalaipido) {
    const lalaipidoTemplate =
      lalaipido.pollingUnits.find((pu) => pu.delimitation === '15/10/09/012') ??
      lalaipido.pollingUnits[0];
    for (const delimitation of ['15/10/09/013', '15/10/09/014'] as const) {
      if (lalaipidoTemplate) {
        upsertPu(lalaipido, lalaipidoTemplate, delimitation, INEC_PU_NAMES[delimitation]);
      }
    }
    lalaipido.pollingUnits = lalaipido.pollingUnits.filter(
      (pu) => pu.name && pu.delimitation && !REMOVE_LALAIPIDO_DELIMITATIONS.has(pu.delimitation),
    );
  }

  if (lapan) {
    lapan.pollingUnits = lapan.pollingUnits.filter((pu) => pu.name && pu.delimitation);
    const template =
      lapan.pollingUnits.find((pu) => pu.delimitation === '15/10/10/011') ?? lapan.pollingUnits[0];
    if (template) {
      for (const units of ['012', '013', '014', '015', '016', '017'] as const) {
        const delimitation = `15/10/10/${units}`;
        const wrongLalaipido = misplacedLapanFromLalaipido.get(units);
        const source =
          lapan.pollingUnits.find((pu) => pu.delimitation === delimitation) ??
          (wrongLalaipido
            ? clonePuTemplate(wrongLalaipido, delimitation, INEC_PU_NAMES[delimitation])
            : template);
        upsertPu(lapan, source, delimitation, INEC_PU_NAMES[delimitation]);
      }
    }
  }

  if (zange && movedZange) {
    upsertPu(zange, movedZange, '15/04/10/025', INEC_PU_NAMES['15/04/10/025']);
  }

  if (kaltungoWest) {
    const template =
      kaltungoWest.pollingUnits.find((pu) => pu.delimitation === '15/07/03/031') ??
      kaltungoWest.pollingUnits[0];
    if (template) {
      upsertPu(kaltungoWest, template, '15/07/03/032', INEC_PU_NAMES['15/07/03/032']);
    }
  }

  return payload;
}

export function delimitationToCode(delimitation: string): string {
  return delimitation.replace(/\//g, '-');
}

export const GOMBE_INEC_REMOVE_CODES = [
  '15-04-09-025',
  '15-10-09-015',
  '15-10-09-016',
  '15-10-09-017',
] as const;

export const GOMBE_INEC_UPSERT = [
  {
    code: '15-04-10-025',
    name: INEC_PU_NAMES['15/04/10/025'],
    lga: 'Dukku',
    ward: 'Zange',
  },
  {
    code: '15-07-03-032',
    name: INEC_PU_NAMES['15/07/03/032'],
    lga: 'Kaltungo',
    ward: 'Kaltungo West',
  },
  {
    code: '15-10-09-013',
    name: INEC_PU_NAMES['15/10/09/013'],
    lga: 'Shongom',
    ward: 'Lalaipido',
  },
  {
    code: '15-10-09-014',
    name: INEC_PU_NAMES['15/10/09/014'],
    lga: 'Shongom',
    ward: 'Lalaipido',
  },
  {
    code: '15-10-10-012',
    name: INEC_PU_NAMES['15/10/10/012'],
    lga: 'Shongom',
    ward: 'Lapan',
  },
  {
    code: '15-10-10-013',
    name: INEC_PU_NAMES['15/10/10/013'],
    lga: 'Shongom',
    ward: 'Lapan',
  },
  {
    code: '15-10-10-014',
    name: INEC_PU_NAMES['15/10/10/014'],
    lga: 'Shongom',
    ward: 'Lapan',
  },
  {
    code: '15-10-10-015',
    name: INEC_PU_NAMES['15/10/10/015'],
    lga: 'Shongom',
    ward: 'Lapan',
  },
  {
    code: '15-10-10-016',
    name: INEC_PU_NAMES['15/10/10/016'],
    lga: 'Shongom',
    ward: 'Lapan',
  },
  {
    code: '15-10-10-017',
    name: INEC_PU_NAMES['15/10/10/017'],
    lga: 'Shongom',
    ward: 'Lapan',
  },
] as const;
