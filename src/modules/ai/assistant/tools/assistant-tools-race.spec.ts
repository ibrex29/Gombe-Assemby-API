import { ContestType, CampaignRole, ScopeType } from '@electromon/shared';
import {
  findAssistantTool,
  toLabeledRaceSummary,
  toRaceSummaryToolResult,
  wrapRaceSummaries,
} from './assistant-tools';

const govRaw = {
  stateName: 'Gombe',
  geographyLevel: 'LGA' as const,
  unitLabel: 'LGAs',
  clientPartyCode: 'PDP',
  summary: {
    lgaCount: 11,
    wins: 3,
    losses: 2,
    ties: 0,
    pending: 6,
  },
  partyStandings: [{ code: 'PDP', name: 'PDP', votes: 100, share: 55 }],
  lgas: [
    {
      name: 'AKKO',
      zone: null,
      outcome: 'WIN',
      leadingParty: 'PDP',
      margin: 20,
      totalVotes: 80,
      clientVotes: 50,
      share: 62.5,
      reporting: { percent: 40 },
      resultStatus: 'APPROVED',
    },
  ],
};

const shaRaw = {
  ...govRaw,
  geographyLevel: 'CONSTITUENCY' as const,
  unitLabel: 'constituencies',
  summary: { ...govRaw.summary, lgaCount: 24 },
  lgas: [
    {
      name: 'Deba',
      zone: null,
      outcome: 'PENDING',
      leadingParty: null,
      margin: 0,
      totalVotes: 0,
      clientVotes: 0,
      share: 0,
      reporting: { percent: 0 },
      resultStatus: 'NOT_STARTED',
    },
  ],
};

describe('race summary helpers', () => {
  it('keeps geographyLevel and unitLabel from the payload', () => {
    const result = toRaceSummaryToolResult(shaRaw as never);
    expect(result.geographyLevel).toBe('CONSTITUENCY');
    expect(result.unitLabel).toBe('constituencies');
    expect(result.summary.unitCount).toBe(24);
  });

  it('labels a race and wraps two contests as races[]', () => {
    const gov = toLabeledRaceSummary(
      { type: ContestType.GOVERNORSHIP, slug: 'governorship', label: 'Governorship' },
      govRaw as never,
    );
    const sha = toLabeledRaceSummary(
      { type: ContestType.ASSEMBLY, slug: 'assembly', label: 'State House of Assembly' },
      shaRaw as never,
    );
    const payload = wrapRaceSummaries([gov, sha]);
    expect(payload).toEqual({ races: [gov, sha] });
    expect(sha.contest.label).toBe('State House of Assembly');
    expect(sha.geographyLevel).toBe('CONSTITUENCY');
  });
});

describe('get_race_summary tool', () => {
  const user = {
    sub: 'user-1',
    campaignId: 'campaign-1',
    role: CampaignRole.CAMPAIGN_DIRECTOR,
    scopeType: ScopeType.CAMPAIGN,
  };

  it('defaults to both contests, each labeled', async () => {
    const govContest = {
      id: 'c-gov',
      campaignId: 'campaign-1',
      type: ContestType.GOVERNORSHIP,
      slug: 'governorship',
      label: 'Governorship',
      irevElectionId: null,
      irevElectionLabel: null,
      isDefault: true,
    };
    const shaContest = {
      id: 'c-sha',
      campaignId: 'campaign-1',
      type: ContestType.ASSEMBLY,
      slug: 'assembly',
      label: 'State House of Assembly',
      irevElectionId: null,
      irevElectionLabel: null,
      isDefault: false,
    };
    const browse = {
      getRaceAnalytics: jest.fn().mockResolvedValue(govRaw),
      getAssemblyRaceAnalytics: jest.fn().mockResolvedValue(shaRaw),
    };
    const contests = {
      list: jest.fn().mockResolvedValue([govContest, shaContest]),
      lookupUnlocked: jest.fn(),
      resolveSeat: jest.fn(),
      run: jest.fn((_contest: unknown, _seat: unknown, fn: () => unknown) => fn()),
      current: jest.fn(),
    };
    const tool = findAssistantTool('get_race_summary');
    const result = await tool!.execute(
      {},
      {
        user,
        campaignId: 'campaign-1',
        browse,
        contests,
        emit: jest.fn(),
      } as never,
    );

    expect(browse.getRaceAnalytics).toHaveBeenCalledTimes(1);
    expect(browse.getAssemblyRaceAnalytics).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        races: [
          expect.objectContaining({
            contest: expect.objectContaining({ label: 'Governorship' }),
            geographyLevel: 'LGA',
          }),
          expect.objectContaining({
            contest: expect.objectContaining({ label: 'State House of Assembly' }),
            geographyLevel: 'CONSTITUENCY',
            unitLabel: 'constituencies',
          }),
        ],
      }),
    );
  });
});
