/** Six geopolitical zones used for the national campaign hierarchy. */

export const NIGERIA_ZONES = [
  'North Central',
  'North East',
  'North West',
  'South East',
  'South South',
  'South West',
] as const;

export type NigeriaZone = (typeof NIGERIA_ZONES)[number];

export const NIGERIA_ZONE_STATES: Record<NigeriaZone, string[]> = {
  'North Central': ['Benue', 'Kogi', 'Kwara', 'Nasarawa', 'Niger', 'Plateau', 'FCT'],
  'North East': ['Adamawa', 'Bauchi', 'Borno', 'Gombe', 'Taraba', 'Yobe'],
  'North West': ['Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Sokoto', 'Zamfara'],
  'South East': ['Abia', 'Anambra', 'Ebonyi', 'Enugu', 'Imo'],
  'South South': ['Akwa Ibom', 'Bayelsa', 'Cross River', 'Delta', 'Edo', 'Rivers'],
  'South West': ['Ekiti', 'Lagos', 'Ogun', 'Ondo', 'Osun', 'Oyo'],
};

export const NIGERIA_STATE_ZONE: Record<string, NigeriaZone> = Object.fromEntries(
  Object.entries(NIGERIA_ZONE_STATES).flatMap(([zone, names]) =>
    names.map((name) => [name.toUpperCase(), zone as NigeriaZone]),
  ),
) as Record<string, NigeriaZone>;

export function zoneForStateName(name: string): NigeriaZone | null {
  return NIGERIA_STATE_ZONE[name.trim().toUpperCase()] ?? null;
}

/** Map URL / filter input to the canonical zone label stored on `state.zone`. */
export function normalizeZoneLabel(zone: string): NigeriaZone | null {
  const key = zone.trim().replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return NIGERIA_ZONES.find((z) => z.toLowerCase() === key) ?? null;
}
