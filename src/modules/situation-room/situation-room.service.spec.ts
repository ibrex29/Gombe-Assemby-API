import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CampaignRole, ElectionDayPhase, PulseSource, ScopeType } from '@electromon/shared';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContestService } from '../../common/contest/contest.service';
import { createMockPrismaService } from '../../../test/helpers/prisma.mock';
import { createMockContestService } from '../../../test/helpers/contest.mock';
import {
  TEST_CAMPAIGN_ID,
  TEST_PU_ID,
  TEST_USER_ID,
  testJwtPayload,
} from '../../../test/helpers/fixtures';
import { SituationRoomService } from './situation-room.service';

describe('SituationRoomService', () => {
  let service: SituationRoomService;
  let prisma: ReturnType<typeof createMockPrismaService>;
  const emit = jest.fn();

  const agent = {
    ...testJwtPayload,
    role: CampaignRole.POLLING_AGENT,
    scopeType: ScopeType.POLLING_UNIT,
    scopeId: TEST_PU_ID,
  };

  const unit = {
    id: TEST_PU_ID,
    code: 'JI-HD-001',
    name: 'Hadejia Central',
    ward: { id: 'ward-test-001', lgaId: 'lga-test-001', lga: { stateId: 'state-ji' } },
  };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    emit.mockClear();
    prisma.$transaction = jest.fn(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    const module = await Test.createTestingModule({
      providers: [
        SituationRoomService,
        { provide: PrismaService, useValue: prisma },
        { provide: ContestService, useValue: createMockContestService() },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();
    service = module.get(SituationRoomService);
    prisma.campaignMembership.findFirst.mockResolvedValue({ id: 'mem-1' });
    prisma.campaign.findUniqueOrThrow.mockResolvedValue({
      stateId: 'state-ji',
      isNational: false,
      clientPartyCode: 'APC',
      trackedParties: [
        { code: 'APC', name: 'APC' },
        { code: 'PDP', name: 'PDP' },
      ],
    });
    prisma.pollingUnit.findFirst.mockResolvedValue(unit);
  });

  it('rejects observed party totals before COUNTING', async () => {
    await expect(
      service.create(agent, {
        campaignId: TEST_CAMPAIGN_ID,
        pollingUnitId: TEST_PU_ID,
        phase: ElectionDayPhase.VOTING,
        observedPartyResults: { APC: 10, PDP: 4 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a pulse for another polling unit', async () => {
    await expect(
      service.create(
        { ...agent, scopeId: 'someone-else' },
        {
          campaignId: TEST_CAMPAIGN_ID,
          pollingUnitId: TEST_PU_ID,
          phase: ElectionDayPhase.CHECKED_IN,
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes history and upserts latest pulse on create', async () => {
    prisma.pollingUnitPulse.findUnique.mockResolvedValue(null);
    prisma.situationUpdate.create.mockResolvedValue({
      id: 'upd-1',
      pollingUnitId: TEST_PU_ID,
      status: 'OPEN',
      createdAt: new Date(),
      pollingUnit: unit,
      reporter: { id: TEST_USER_ID, firstName: 'A', lastName: 'B' },
    });
    prisma.pollingUnitPulse.upsert.mockResolvedValue({});

    await service.create(agent, {
      campaignId: TEST_CAMPAIGN_ID,
      pollingUnitId: TEST_PU_ID,
      phase: ElectionDayPhase.COUNTING,
      observedPartyResults: { APC: 20, PDP: 11 },
    });

    expect(prisma.situationUpdate.create).toHaveBeenCalled();
    expect(prisma.pollingUnitPulse.upsert).toHaveBeenCalled();
    expect(emit).toHaveBeenCalled();
  });

  it('creates CHECKED_IN on first check-in', async () => {
    const createdPulse = {
      pollingUnitId: TEST_PU_ID,
      phase: ElectionDayPhase.CHECKED_IN,
      lastPulseAt: new Date(),
      pollingUnit: { id: TEST_PU_ID, code: unit.code, name: unit.name },
      reporter: { id: TEST_USER_ID, firstName: 'A', lastName: 'B' },
    };
    prisma.pollingUnitPulse.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdPulse);
    prisma.situationUpdate.create.mockResolvedValue({
      id: 'upd-checkin',
      pollingUnitId: TEST_PU_ID,
      status: 'OPEN',
      phase: ElectionDayPhase.CHECKED_IN,
      createdAt: new Date(),
      pollingUnit: unit,
      reporter: { id: TEST_USER_ID, firstName: 'A', lastName: 'B' },
    });
    prisma.pollingUnitPulse.upsert.mockResolvedValue({});

    const pulse = await service.checkIn(agent, { campaignId: TEST_CAMPAIGN_ID });
    expect(prisma.situationUpdate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: ElectionDayPhase.CHECKED_IN,
          source: PulseSource.CHECK_IN,
        }),
      }),
    );
    expect(pulse.phase).toBe(ElectionDayPhase.CHECKED_IN);
  });

  it('does not regress VOTING on a second check-in', async () => {
    prisma.pollingUnitPulse.findUnique.mockResolvedValue({
      pollingUnitId: TEST_PU_ID,
      phase: ElectionDayPhase.VOTING,
      lastPulseAt: new Date(),
      pollingUnit: { id: TEST_PU_ID, code: unit.code, name: unit.name },
      reporter: { id: TEST_USER_ID, firstName: 'A', lastName: 'B' },
    });

    const pulse = await service.checkIn(agent, { campaignId: TEST_CAMPAIGN_ID });
    expect(prisma.situationUpdate.create).not.toHaveBeenCalled();
    expect(pulse.phase).toBe(ElectionDayPhase.VOTING);
  });

  it('heartbeats lastPulseAt without notifying', async () => {
    const existing = {
      pollingUnitId: TEST_PU_ID,
      phase: ElectionDayPhase.VOTING,
      lastPulseAt: new Date('2026-02-25T08:00:00Z'),
      pollingUnit: { id: TEST_PU_ID, code: unit.code, name: unit.name },
      reporter: { id: TEST_USER_ID, firstName: 'A', lastName: 'B' },
    };
    prisma.pollingUnitPulse.findUnique.mockResolvedValue(existing);
    prisma.pollingUnitPulse.update.mockResolvedValue(existing);

    await service.heartbeat(agent, { campaignId: TEST_CAMPAIGN_ID });
    expect(prisma.pollingUnitPulse.update).toHaveBeenCalled();
    expect(prisma.situationUpdate.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('writes COUNTING and observed totals from an inferred result pulse', async () => {
    prisma.pollingUnitPulse.findUnique.mockResolvedValue({
      phase: ElectionDayPhase.VOTING,
      atmosphere: null,
      bvasStatus: null,
      rivalMobilization: null,
      rivalTactics: [],
      observedPartyResults: null,
    });
    prisma.situationUpdate.create.mockResolvedValue({
      id: 'upd-count',
      pollingUnitId: TEST_PU_ID,
      status: 'REPORTING',
      createdAt: new Date(),
      pollingUnit: unit,
      reporter: { id: TEST_USER_ID, firstName: 'A', lastName: 'B' },
    });
    prisma.pollingUnitPulse.upsert.mockResolvedValue({});

    await service.ingestInferredPulse({
      campaignId: TEST_CAMPAIGN_ID,
      pollingUnitId: TEST_PU_ID,
      reportedById: TEST_USER_ID,
      source: PulseSource.RESULT,
      phase: ElectionDayPhase.COUNTING,
      observedPartyResults: { APC: 40, PDP: 12 },
    });

    expect(prisma.situationUpdate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: ElectionDayPhase.COUNTING,
          source: PulseSource.RESULT,
        }),
      }),
    );
  });
});
