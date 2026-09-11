import { ChartBuildError, buildChart } from './chart-builder';

const raceSummary = {
  geographyLevel: 'STATE',
  unitLabel: 'States',
  partyStandings: [
    { code: 'APC', name: 'APC', votes: 500_000, sharePercent: 40 },
    { code: 'PDP', name: 'PDP', votes: 350_000, sharePercent: 28 },
    { code: 'LP', name: 'LP', votes: 200_000, sharePercent: 16 },
  ],
  zonePartyStandings: {
    'North West': [
      { code: 'APC', name: 'APC', votes: 200_000, sharePercent: 55 },
      { code: 'PDP', name: 'PDP', votes: 100_000, sharePercent: 27.5 },
      { code: 'NNPP', name: 'NNPP', votes: 64_000, sharePercent: 17.5 },
    ],
    'South East': [
      { code: 'LP', name: 'LP', votes: 80_000, sharePercent: 60 },
      { code: 'PDP', name: 'PDP', votes: 40_000, sharePercent: 30 },
      { code: 'APC', name: 'APC', votes: 13_000, sharePercent: 10 },
    ],
  },
  units: [
    {
      name: 'Kano',
      zone: 'North West',
      sharePercent: 41.2,
      openIncidents: 4,
      totalVotes: 120_000,
      clientVotes: 49_000,
    },
    {
      name: 'Lagos',
      zone: 'South West',
      sharePercent: 28.4,
      openIncidents: 6,
      totalVotes: 200_000,
      clientVotes: 56_000,
    },
    {
      name: 'Sokoto',
      zone: 'North West',
      sharePercent: 52.1,
      openIncidents: 1,
      totalVotes: 90_000,
      clientVotes: 46_000,
    },
    {
      name: 'Enugu',
      zone: 'South East',
      sharePercent: 18.6,
      openIncidents: 1,
      totalVotes: 90_000,
      clientVotes: 16_000,
    },
  ],
};

const hotspots = {
  geographyLevel: 'STATE',
  unitLabel: 'States',
  hotspots: [
    { name: 'Lagos', openIncidents: 6, urgentIncidents: 4, severityWeight: 17 },
    { name: 'Kano', openIncidents: 4, urgentIncidents: 4, severityWeight: 13 },
  ],
};

const results = new Map<string, unknown>([
  ['get_race_summary', raceSummary],
  ['get_incident_hotspots', hotspots],
]);

describe('buildChart', () => {
  it('charts the governorship block when get_race_summary returned both races', () => {
    const dual = {
      races: [
        {
          contest: { type: 'GOVERNORSHIP', label: 'Governorship' },
          geographyLevel: 'LGA',
          unitLabel: 'LGAs',
          units: [
            { name: 'Akko', sharePercent: 41, clientVotes: 200 },
            { name: 'Billiri', sharePercent: 22, clientVotes: 80 },
          ],
          partyStandings: raceSummary.partyStandings,
        },
        {
          contest: { type: 'ASSEMBLY', label: 'State House of Assembly' },
          geographyLevel: 'CONSTITUENCY',
          unitLabel: 'constituencies',
          units: [{ name: 'Deba', sharePercent: 51, clientVotes: 90 }],
          partyStandings: raceSummary.partyStandings,
        },
      ],
    };
    const chart = buildChart(
      { type: 'bar', source: 'race_summary', metric: 'sharePercent' },
      new Map([['get_race_summary', dual]]),
    );
    expect(chart.series.map((point) => point.label)).toEqual(['Akko', 'Billiri']);
  });

  it('builds a series from the real tool result', () => {
    const chart = buildChart(
      { type: 'bar', source: 'race_summary', metric: 'sharePercent' },
      results,
    );

    expect(chart.type).toBe('bar');
    expect(chart.unit).toBe('%');
    // Sorted highest first.
    expect(chart.series).toEqual([
      { label: 'Sokoto', value: 52.1 },
      { label: 'Kano', value: 41.2 },
      { label: 'Lagos', value: 28.4 },
      { label: 'Enugu', value: 18.6 },
    ]);
  });

  it('charts incident hotspots', () => {
    const chart = buildChart(
      { type: 'bar', source: 'incident_hotspots', metric: 'severityWeight' },
      results,
    );
    expect(chart.series[0]).toEqual({ label: 'Lagos', value: 17 });
  });

  it('honours top-N', () => {
    const chart = buildChart(
      { type: 'bar', source: 'race_summary', metric: 'sharePercent', top: 2 },
      results,
    );
    expect(chart.series).toHaveLength(2);
  });

  it('names the chart after the metric and unit when no title is given', () => {
    const chart = buildChart(
      { type: 'bar', source: 'race_summary', metric: 'sharePercent' },
      results,
    );
    expect(chart.title).toBe('Share Percent by State');
  });

  it('charts national party standings as a donut', () => {
    const chart = buildChart(
      { type: 'donut', source: 'party_standings', metric: 'votes' },
      results,
    );
    expect(chart.unit).toBe('votes');
    expect(chart.series[0]).toEqual({ label: 'APC', value: 500_000 });
    expect(chart.title).toBe('Party votes');
  });

  it('charts party standings for one geopolitical zone', () => {
    const chart = buildChart(
      {
        type: 'donut',
        source: 'party_standings',
        metric: 'sharePercent',
        zone: 'north west',
      },
      results,
    );
    expect(chart.unit).toBe('%');
    expect(chart.series).toEqual([
      { label: 'APC', value: 55 },
      { label: 'PDP', value: 27.5 },
      { label: 'NNPP', value: 17.5 },
    ]);
    expect(chart.title).toContain('North West');
  });

  it('filters race_summary rows to one zone', () => {
    const chart = buildChart(
      {
        type: 'bar',
        source: 'race_summary',
        metric: 'sharePercent',
        zone: 'North West',
      },
      results,
    );
    expect(chart.series.map((p) => p.label)).toEqual(['Sokoto', 'Kano']);
  });

  describe('refuses anything the data cannot back', () => {
    it('rejects a metric that is not on the source', () => {
      expect(() =>
        buildChart(
          { type: 'bar', source: 'race_summary', metric: 'severityWeight' },
          results,
        ),
      ).toThrow(ChartBuildError);
    });

    it('rejects a metric that exists nowhere', () => {
      expect(() =>
        buildChart({ type: 'bar', source: 'race_summary', metric: 'vibes' }, results),
      ).toThrow(ChartBuildError);
    });

    it('refuses to chart a tool that was never called this turn', () => {
      // The whole point: the model cannot conjure a chart out of nothing, so it
      // cannot produce authoritative-looking figures the grounding check never sees.
      expect(() =>
        buildChart(
          { type: 'bar', source: 'incident_hotspots', metric: 'openIncidents' },
          new Map([['get_race_summary', raceSummary]]),
        ),
      ).toThrow(/Call get_incident_hotspots first/);
    });

    it('rejects a source whose rows are all non-numeric', () => {
      const empty = new Map<string, unknown>([
        ['get_race_summary', { units: [{ name: 'Kano', sharePercent: null }] }],
      ]);
      expect(() =>
        buildChart({ type: 'bar', source: 'race_summary', metric: 'sharePercent' }, empty),
      ).toThrow(ChartBuildError);
    });

    it('rejects an unknown zone for party standings', () => {
      expect(() =>
        buildChart(
          {
            type: 'donut',
            source: 'party_standings',
            metric: 'votes',
            zone: 'Middle Belt',
          },
          results,
        ),
      ).toThrow(/No party standings for zone/);
    });
  });
});
