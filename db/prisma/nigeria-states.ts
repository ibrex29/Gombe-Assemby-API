/** 36 states + FCT for the national APC campaign. INEC codes match JayCodist slugs. */

export type SeedOutcome =
  | 'WIN'
  | 'LOSS'
  | 'TIE'
  | 'CLOSE_WIN'
  | 'CLOSE_LOSS'
  | 'LANDSLIDE_WIN'
  | 'LANDSLIDE_LOSS'
  | 'PENDING';

export interface NigeriaStateMeta {
  name: string;
  /** ISO-style 2-letter code used in Electromon (FC = FCT). */
  code: string;
  /** INEC 2-digit state code, e.g. "24" for Lagos. */
  inecCode: string;
  /** JayCodist results/{slug}.json filename without extension. */
  slug: string;
  zone:
    | 'North Central'
    | 'North East'
    | 'North West'
    | 'South East'
    | 'South South'
    | 'South West';
  districts: [string, string, string];
  /** Demo APC outcome for Situation Room heatmap. */
  outcome: SeedOutcome;
  geoAliases: string[];
}

/** Approximate [lng, lat] from GADM state polygons — used to place ward/PU markers. */
export const NIGERIA_STATE_CENTROIDS: Record<string, [number, number]> = {
  AB: [7.5123, 5.4247],
  AD: [12.739, 9.2445],
  AK: [7.8436, 4.7058],
  AN: [6.9444, 6.2272],
  BA: [9.9372, 10.8522],
  BY: [6.1376, 4.5584],
  BE: [8.7047, 7.2275],
  BO: [13.5254, 12.3588],
  CR: [8.6364, 5.7303],
  DE: [5.5456, 5.5498],
  EB: [8.0047, 6.1997],
  ED: [5.8765, 6.7333],
  EK: [5.3884, 7.7559],
  EN: [7.3388, 6.4933],
  FC: [7.2617, 8.9714],
  GO: [11.2087, 10.4645],
  IM: [7.0498, 5.5465],
  JI: [9.3213, 12.2002],
  KD: [7.6106, 10.1885],
  KN: [8.4858, 11.6754],
  KT: [7.7998, 12.3098],
  KE: [4.7694, 11.5734],
  KO: [6.5346, 7.6845],
  KW: [4.1971, 8.8588],
  LA: [3.5602, 6.5078],
  NA: [8.243, 8.6249],
  NI: [5.525, 10.0257],
  OG: [3.5884, 6.9599],
  ON: [5.1704, 6.8063],
  OS: [4.527, 7.5439],
  OY: [3.596, 8.1127],
  PL: [9.2714, 9.323],
  RI: [7.0832, 4.6219],
  SO: [5.2275, 12.7875],
  TA: [10.7795, 7.3526],
  YO: [11.46, 12.4728],
  ZA: [6.2195, 12.0831],
};

export const NIGERIA_STATES: NigeriaStateMeta[] = [
  { name: 'Abia', code: 'AB', inecCode: '01', slug: 'abia', zone: 'South East', districts: ['Abia North', 'Abia Central', 'Abia South'], outcome: 'LOSS', geoAliases: ['ABIA'] },
  { name: 'Adamawa', code: 'AD', inecCode: '02', slug: 'adamawa', zone: 'North East', districts: ['Adamawa North', 'Adamawa Central', 'Adamawa South'], outcome: 'CLOSE_WIN', geoAliases: ['ADAMAWA'] },
  { name: 'Akwa Ibom', code: 'AK', inecCode: '03', slug: 'akwa-ibom', zone: 'South South', districts: ['Akwa Ibom North East', 'Akwa Ibom North West', 'Akwa Ibom South'], outcome: 'LOSS', geoAliases: ['AKWA IBOM', 'AKWA-IBOM'] },
  { name: 'Anambra', code: 'AN', inecCode: '04', slug: 'anambra', zone: 'South East', districts: ['Anambra North', 'Anambra Central', 'Anambra South'], outcome: 'LOSS', geoAliases: ['ANAMBRA'] },
  { name: 'Bauchi', code: 'BA', inecCode: '05', slug: 'bauchi', zone: 'North East', districts: ['Bauchi North', 'Bauchi Central', 'Bauchi South'], outcome: 'WIN', geoAliases: ['BAUCHI'] },
  { name: 'Bayelsa', code: 'BY', inecCode: '06', slug: 'bayelsa', zone: 'South South', districts: ['Bayelsa Central', 'Bayelsa East', 'Bayelsa West'], outcome: 'LOSS', geoAliases: ['BAYELSA'] },
  { name: 'Benue', code: 'BE', inecCode: '07', slug: 'benue', zone: 'North Central', districts: ['Benue North East', 'Benue North West', 'Benue South'], outcome: 'TIE', geoAliases: ['BENUE'] },
  { name: 'Borno', code: 'BO', inecCode: '08', slug: 'borno', zone: 'North East', districts: ['Borno Central', 'Borno North', 'Borno South'], outcome: 'LANDSLIDE_WIN', geoAliases: ['BORNO'] },
  { name: 'Cross River', code: 'CR', inecCode: '09', slug: 'cross-river', zone: 'South South', districts: ['Cross River Central', 'Cross River North', 'Cross River South'], outcome: 'CLOSE_LOSS', geoAliases: ['CROSS RIVER', 'CROSS-RIVER'] },
  { name: 'Delta', code: 'DE', inecCode: '10', slug: 'delta', zone: 'South South', districts: ['Delta Central', 'Delta North', 'Delta South'], outcome: 'CLOSE_LOSS', geoAliases: ['DELTA'] },
  { name: 'Ebonyi', code: 'EB', inecCode: '11', slug: 'ebonyi', zone: 'South East', districts: ['Ebonyi North', 'Ebonyi Central', 'Ebonyi South'], outcome: 'LOSS', geoAliases: ['EBONYI'] },
  { name: 'Edo', code: 'ED', inecCode: '12', slug: 'edo', zone: 'South South', districts: ['Edo Central', 'Edo North', 'Edo South'], outcome: 'CLOSE_WIN', geoAliases: ['EDO'] },
  { name: 'Ekiti', code: 'EK', inecCode: '13', slug: 'ekiti', zone: 'South West', districts: ['Ekiti Central', 'Ekiti North', 'Ekiti South'], outcome: 'WIN', geoAliases: ['EKITI'] },
  { name: 'Enugu', code: 'EN', inecCode: '14', slug: 'enugu', zone: 'South East', districts: ['Enugu East', 'Enugu North', 'Enugu West'], outcome: 'LOSS', geoAliases: ['ENUGU'] },
  { name: 'Gombe', code: 'GO', inecCode: '15', slug: 'gombe', zone: 'North East', districts: ['Gombe Central', 'Gombe North', 'Gombe South'], outcome: 'WIN', geoAliases: ['GOMBE'] },
  { name: 'Imo', code: 'IM', inecCode: '16', slug: 'imo', zone: 'South East', districts: ['Imo East', 'Imo North', 'Imo West'], outcome: 'LOSS', geoAliases: ['IMO'] },
  { name: 'Jigawa', code: 'JI', inecCode: '17', slug: 'jigawa', zone: 'North West', districts: ['Jigawa North East', 'Jigawa North West', 'Jigawa South West'], outcome: 'LANDSLIDE_WIN', geoAliases: ['JIGAWA'] },
  { name: 'Kaduna', code: 'KD', inecCode: '18', slug: 'kaduna', zone: 'North West', districts: ['Kaduna Central', 'Kaduna North', 'Kaduna South'], outcome: 'WIN', geoAliases: ['KADUNA'] },
  { name: 'Kano', code: 'KN', inecCode: '19', slug: 'kano', zone: 'North West', districts: ['Kano Central', 'Kano North', 'Kano South'], outcome: 'WIN', geoAliases: ['KANO'] },
  { name: 'Katsina', code: 'KT', inecCode: '20', slug: 'katsina', zone: 'North West', districts: ['Katsina Central', 'Katsina North', 'Katsina South'], outcome: 'LANDSLIDE_WIN', geoAliases: ['KATSINA'] },
  { name: 'Kebbi', code: 'KE', inecCode: '21', slug: 'kebbi', zone: 'North West', districts: ['Kebbi Central', 'Kebbi North', 'Kebbi South'], outcome: 'WIN', geoAliases: ['KEBBI'] },
  { name: 'Kogi', code: 'KO', inecCode: '22', slug: 'kogi', zone: 'North Central', districts: ['Kogi Central', 'Kogi East', 'Kogi West'], outcome: 'WIN', geoAliases: ['KOGI'] },
  { name: 'Kwara', code: 'KW', inecCode: '23', slug: 'kwara', zone: 'North Central', districts: ['Kwara Central', 'Kwara North', 'Kwara South'], outcome: 'WIN', geoAliases: ['KWARA'] },
  { name: 'Lagos', code: 'LA', inecCode: '24', slug: 'lagos', zone: 'South West', districts: ['Lagos Central', 'Lagos East', 'Lagos West'], outcome: 'WIN', geoAliases: ['LAGOS'] },
  { name: 'Nasarawa', code: 'NA', inecCode: '25', slug: 'nasarawa', zone: 'North Central', districts: ['Nasarawa North', 'Nasarawa South', 'Nasarawa West'], outcome: 'PENDING', geoAliases: ['NASARAWA', 'NASSARAWA'] },
  { name: 'Niger', code: 'NI', inecCode: '26', slug: 'niger', zone: 'North Central', districts: ['Niger East', 'Niger North', 'Niger South'], outcome: 'WIN', geoAliases: ['NIGER'] },
  { name: 'Ogun', code: 'OG', inecCode: '27', slug: 'ogun', zone: 'South West', districts: ['Ogun Central', 'Ogun East', 'Ogun West'], outcome: 'WIN', geoAliases: ['OGUN'] },
  { name: 'Ondo', code: 'ON', inecCode: '28', slug: 'ondo', zone: 'South West', districts: ['Ondo Central', 'Ondo North', 'Ondo South'], outcome: 'CLOSE_WIN', geoAliases: ['ONDO'] },
  { name: 'Osun', code: 'OS', inecCode: '29', slug: 'osun', zone: 'South West', districts: ['Osun Central', 'Osun East', 'Osun West'], outcome: 'WIN', geoAliases: ['OSUN'] },
  { name: 'Oyo', code: 'OY', inecCode: '30', slug: 'oyo', zone: 'South West', districts: ['Oyo Central', 'Oyo North', 'Oyo South'], outcome: 'WIN', geoAliases: ['OYO'] },
  { name: 'Plateau', code: 'PL', inecCode: '31', slug: 'plateau', zone: 'North Central', districts: ['Plateau Central', 'Plateau North', 'Plateau South'], outcome: 'CLOSE_WIN', geoAliases: ['PLATEAU'] },
  { name: 'Rivers', code: 'RI', inecCode: '32', slug: 'rivers', zone: 'South South', districts: ['Rivers East', 'Rivers South East', 'Rivers West'], outcome: 'LOSS', geoAliases: ['RIVERS'] },
  { name: 'Sokoto', code: 'SO', inecCode: '33', slug: 'sokoto', zone: 'North West', districts: ['Sokoto East', 'Sokoto North', 'Sokoto South'], outcome: 'WIN', geoAliases: ['SOKOTO'] },
  { name: 'Taraba', code: 'TA', inecCode: '34', slug: 'taraba', zone: 'North East', districts: ['Taraba Central', 'Taraba North', 'Taraba South'], outcome: 'TIE', geoAliases: ['TARABA'] },
  { name: 'Yobe', code: 'YO', inecCode: '35', slug: 'yobe', zone: 'North East', districts: ['Yobe East', 'Yobe North', 'Yobe South'], outcome: 'LANDSLIDE_WIN', geoAliases: ['YOBE'] },
  { name: 'Zamfara', code: 'ZA', inecCode: '36', slug: 'zamfara', zone: 'North West', districts: ['Zamfara Central', 'Zamfara North', 'Zamfara West'], outcome: 'PENDING', geoAliases: ['ZAMFARA'] },
  {
    name: 'FCT',
    code: 'FC',
    inecCode: '37',
    slug: 'federal-capital-territory',
    zone: 'North Central',
    districts: ['FCT Senatorial District', 'Abuja Municipal', 'Abuja Area Councils'],
    outcome: 'CLOSE_WIN',
    geoAliases: ['FCT', 'FCT ABUJA', 'ABUJA', 'FEDERAL CAPITAL TERRITORY', 'FEDERAL CAPITAL TERRITORY (FCT)'],
  },
];

export const NIGERIA_STATE_BY_CODE = Object.fromEntries(
  NIGERIA_STATES.map((s) => [s.code, s]),
) as Record<string, NigeriaStateMeta>;
