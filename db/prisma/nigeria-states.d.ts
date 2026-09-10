export type SeedOutcome = 'WIN' | 'LOSS' | 'TIE' | 'CLOSE_WIN' | 'CLOSE_LOSS' | 'LANDSLIDE_WIN' | 'LANDSLIDE_LOSS' | 'PENDING';
export interface NigeriaStateMeta {
    name: string;
    code: string;
    inecCode: string;
    slug: string;
    zone: 'North Central' | 'North East' | 'North West' | 'South East' | 'South South' | 'South West';
    districts: [string, string, string];
    outcome: SeedOutcome;
    geoAliases: string[];
}
export declare const NIGERIA_STATE_CENTROIDS: Record<string, [number, number]>;
export declare const NIGERIA_STATES: NigeriaStateMeta[];
export declare const NIGERIA_STATE_BY_CODE: Record<string, NigeriaStateMeta>;
