import { ContestType } from '@electromon/shared';

export const TEST_CONTEST_ID = 'contest-gov';

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

export function createMockContestService() {
  return {
    id: jest.fn(() => TEST_CONTEST_ID),
    scope: jest.fn((campaignId: string) => ({ campaignId, contestId: TEST_CONTEST_ID })),
    current: jest.fn(() => testContest),
    list: jest.fn(async () => [testContest]),
    resolve: jest.fn(async () => testContest),
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
