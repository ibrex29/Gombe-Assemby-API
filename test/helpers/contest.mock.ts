import { ContestType } from '@electromon/shared';

export const TEST_CONTEST_ID = 'contest-gov';
export const TEST_ASSEMBLY_CONTEST_ID = 'contest-sha';

export const testContest = {
  id: TEST_CONTEST_ID,
  campaignId: 'campaign-1',
  type: ContestType.GOVERNORSHIP,
  slug: 'governorship',
  label: 'Governorship',
  irevElectionId: '6407d9bfce35006e92156f2e',
  irevElectionLabel: 'Gombe Governorship Election',
  isDefault: true,
};

export const testAssemblyContest = {
  id: TEST_ASSEMBLY_CONTEST_ID,
  campaignId: 'campaign-1',
  type: ContestType.ASSEMBLY,
  slug: 'assembly',
  label: 'State House of Assembly',
  irevElectionId: null,
  irevElectionLabel: 'Gombe State House of Assembly Election',
  isDefault: false,
};

export function createMockContestService() {
  return {
    id: jest.fn(() => TEST_CONTEST_ID),
    scope: jest.fn((campaignId: string) => ({ campaignId, contestId: TEST_CONTEST_ID })),
    current: jest.fn(() => testContest),
    explicit: jest.fn(() => false),
    list: jest.fn(async () => [testContest, testAssemblyContest]),
    resolve: jest.fn(async () => testContest),
    lookupUnlocked: jest.fn(async () => testContest),
    active: jest.fn(async () => testContest),
    run: jest.fn((...args: unknown[]) => {
      const fn = args[args.length - 1] as () => unknown;
      return fn();
    }),
    seat: jest.fn(() => null),
    listSeats: jest.fn(async () => []),
    resolveSeat: jest.fn(async () => null),
    resultKey: jest.fn(
      (campaignId: string, level: string, scopeType: string, scopeId: string) => ({
        campaignId_contestId_level_scopeType_scopeId: {
          campaignId,
          contestId: TEST_CONTEST_ID,
          level,
          scopeType,
          scopeId,
        },
      }),
    ),
  };
}
