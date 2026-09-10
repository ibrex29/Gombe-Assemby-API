/**
 * Builds chart data from tool results the model already fetched this turn.
 *
 * The model chooses the *view* — chart type, source, metric — and the server
 * supplies every number from the real tool output. This is deliberate: the
 * grounding check only inspects the reply text, so a model allowed to author
 * chart data could fabricate an authoritative-looking chart that never trips it.
 * Here there is nothing to fabricate.
 */

export type ChartType = 'bar' | 'donut';

/** Which earlier tool result to read. */
export type ChartSource =
  | 'race_summary'
  | 'incident_hotspots'
  | 'party_standings';

export const CHART_METRICS = {
  race_summary: [
    'sharePercent',
    'clientVotes',
    'totalVotes',
    'margin',
    'reportingPercent',
  ],
  incident_hotspots: ['openIncidents', 'urgentIncidents', 'severityWeight'],
  party_standings: ['votes', 'sharePercent'],
} as const;

export interface ChartRequest {
  type: ChartType;
  source: ChartSource;
  metric: string;
  title?: string;
  /** Rows to keep, highest first. */
  top?: number;
  /**
   * Optional geopolitical zone (e.g. "North West").
   * For race_summary: keeps only units in that zone.
   * For party_standings: charts that zone's party totals (from zonePartyStandings).
   */
  zone?: string;
}

export interface ChartSeriesPoint {
  label: string;
  value: number;
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  unit: string;
  series: ChartSeriesPoint[];
}

export class ChartBuildError extends Error {}

const MAX_POINTS = 15;

const UNIT_BY_METRIC: Record<string, string> = {
  sharePercent: '%',
  reportingPercent: '%',
  clientVotes: 'votes',
  totalVotes: 'votes',
  votes: 'votes',
  margin: 'votes',
  openIncidents: 'incidents',
  urgentIncidents: 'incidents',
  severityWeight: 'weight',
};

const TOOL_BY_SOURCE: Record<ChartSource, string> = {
  race_summary: 'get_race_summary',
  party_standings: 'get_race_summary',
  incident_hotspots: 'get_incident_hotspots',
};

/**
 * @param results tool outputs from this turn, keyed by tool name
 */
export function buildChart(
  request: ChartRequest,
  results: Map<string, unknown>,
): ChartSpec {
  const allowedMetrics: readonly string[] = CHART_METRICS[request.source] ?? [];
  if (!allowedMetrics.includes(request.metric)) {
    throw new ChartBuildError(
      `Metric "${request.metric}" is not available for ${request.source}. Available: ${allowedMetrics.join(', ')}.`,
    );
  }

  const toolName = TOOL_BY_SOURCE[request.source];
  const raw = results.get(toolName);
  if (!raw) {
    throw new ChartBuildError(
      `No ${toolName} result in this turn. Call ${toolName} first, then chart it.`,
    );
  }

  const zone = normalizeZone(request.zone);
  const { rows, unitLabel, zoneLabel } = extractRows(request.source, raw, zone);
  const defaultTop = request.source === 'party_standings' ? 8 : 10;
  const series = rows
    // Number(null) is 0, so missing values must be dropped before conversion —
    // otherwise a state with no data charts as a confident zero.
    .filter((row) => row[request.metric] !== null && row[request.metric] !== undefined)
    .map((row) => ({
      label: String(row.label ?? '').trim() || '—',
      value: Number(row[request.metric]),
    }))
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.min(Math.max(request.top ?? defaultTop, 2), MAX_POINTS));

  if (series.length === 0) {
    throw new ChartBuildError(
      zone
        ? `No values for "${request.metric}" in ${zone} to chart.`
        : `No values for "${request.metric}" to chart.`,
    );
  }

  const titleZone = zoneLabel ?? zone;

  return {
    type: request.type,
    title: request.title?.trim() || defaultTitle(request, unitLabel, titleZone),
    unit: UNIT_BY_METRIC[request.metric] ?? '',
    series,
  };
}

function normalizeZone(zone: string | undefined): string | null {
  const trimmed = zone?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, ' ');
}

function zonesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function extractRows(
  source: ChartSource,
  raw: unknown,
  zone: string | null,
): { rows: Array<Record<string, unknown>>; unitLabel: string; zoneLabel?: string } {
  const payload = raw as Record<string, unknown>;
  const unitLabel = typeof payload.unitLabel === 'string' ? payload.unitLabel : 'Units';

  if (source === 'party_standings') {
    return extractPartyRows(payload, zone);
  }

  if (source === 'race_summary') {
    const units = Array.isArray(payload.units) ? payload.units : [];
    let zoneLabel: string | undefined;
    const filtered = zone
      ? units.filter((unit) => {
          const u = unit as Record<string, unknown>;
          if (typeof u.zone === 'string' && zonesMatch(u.zone, zone)) {
            zoneLabel ??= u.zone.trim();
            return true;
          }
          return false;
        })
      : units;
    if (zone && filtered.length === 0) {
      throw new ChartBuildError(
        `No race_summary units found for zone "${zone}". Use a zone name from the data (e.g. North West).`,
      );
    }
    return {
      rows: filtered.map((unit) => {
        const u = unit as Record<string, unknown>;
        return { ...u, label: u.name };
      }),
      unitLabel: zone ? 'States' : unitLabel,
      zoneLabel,
    };
  }

  const hotspots = Array.isArray(payload.hotspots) ? payload.hotspots : [];
  return {
    rows: hotspots.map((hotspot) => {
      const h = hotspot as Record<string, unknown>;
      return { ...h, label: h.name };
    }),
    unitLabel,
  };
}

function extractPartyRows(
  payload: Record<string, unknown>,
  zone: string | null,
): { rows: Array<Record<string, unknown>>; unitLabel: string; zoneLabel?: string } {
  if (zone) {
    const byZone = payload.zonePartyStandings;
    if (!byZone || typeof byZone !== 'object') {
      throw new ChartBuildError(
        'No zonePartyStandings on the race summary. Call get_race_summary again on a national campaign.',
      );
    }
    const entries = Object.entries(byZone as Record<string, unknown>);
    const match = entries.find(([name]) => zonesMatch(name, zone));
    if (!match) {
      const available = entries.map(([name]) => name).join(', ') || '(none)';
      throw new ChartBuildError(
        `No party standings for zone "${zone}". Available: ${available}.`,
      );
    }
    return {
      rows: partyRowsFromList(match[1]),
      unitLabel: 'Parties',
      zoneLabel: match[0],
    };
  }

  return {
    rows: partyRowsFromList(payload.partyStandings),
    unitLabel: 'Parties',
  };
}

function partyRowsFromList(list: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(list) || list.length === 0) {
    throw new ChartBuildError('No party standings available to chart.');
  }
  return list.map((party) => {
    const p = party as Record<string, unknown>;
    const code = String(p.code ?? '').trim() || '—';
    return {
      ...p,
      // Prefer the INEC code so the client can colour the slice; name stays in data.
      label: code,
      votes: p.votes,
      sharePercent: p.sharePercent ?? p.share,
    };
  });
}

function defaultTitle(
  request: ChartRequest,
  unitLabel: string,
  zone: string | null,
): string {
  const metric = request.metric
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
  if (request.source === 'party_standings') {
    return zone ? `Party ${metric.toLowerCase()} — ${zone}` : `Party ${metric.toLowerCase()}`;
  }
  if (zone) {
    return `${metric} by ${unitLabel.replace(/s$/, '')} — ${zone}`;
  }
  return `${metric} by ${unitLabel.replace(/s$/, '')}`;
}
