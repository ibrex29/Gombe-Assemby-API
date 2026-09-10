import { TriageSchedulerService } from './triage-scheduler.service';

function build(overrides: Record<string, string> = {}) {
  const config = {
    get: (key: string) => overrides[key],
  } as never;
  const triageScoreFindMany = jest.fn().mockResolvedValue([]);
  const snapshotDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    campaign: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'campaign-1', name: 'A4A' }]),
    },
    triageScore: { findMany: triageScoreFindMany },
    triageSnapshot: { deleteMany: snapshotDeleteMany },
    // The sweep resolves an actor so its notifications have an author.
    campaignMembership: {
      findFirst: jest.fn().mockResolvedValue({ userId: 'director-1' }),
    },
  } as never;
  const redis = {
    isConnected: jest.fn().mockReturnValue(false),
    acquireLock: jest.fn().mockResolvedValue(true),
  };
  const triage = {
    rescore: jest.fn().mockResolvedValue({ transitions: [] }),
    rescoreChildren: jest.fn().mockResolvedValue({ scored: 11 }),
    rescoreScopes: jest
      .fn()
      .mockResolvedValue({ scored: 1, changed: 1, unchanged: 0, transitions: [] }),
  };

  const trigger = {
    takeDirty: jest.fn().mockReturnValue([]),
    pendingCount: jest.fn().mockReturnValue(0),
  };

  const service = new TriageSchedulerService(
    config,
    prisma,
    redis as never,
    triage as never,
    trigger as never,
  );
  return {
    service,
    redis,
    triage,
    prisma,
    trigger,
    triageScoreFindMany,
    snapshotDeleteMany,
  };
}

describe('TriageSchedulerService', () => {
  it('does not start unless explicitly enabled', () => {
    const { service } = build();
    const spy = jest.spyOn(global, 'setInterval');
    service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('sweeps both levels for every active campaign', async () => {
    const { service, triage } = build();
    await service.tick();
    expect(triage.rescore).toHaveBeenCalledTimes(2);
    const levels = (triage.rescore.mock.calls as unknown[][]).map(
      (call) => call[1],
    );
    expect(levels).toEqual(['STATE', 'LGA']);
  });

  it('runs without Redis, since a single instance needs no lock', async () => {
    const { service, redis, triage } = build();
    await service.tick();
    expect(redis.acquireLock).not.toHaveBeenCalled();
    expect(triage.rescore).toHaveBeenCalled();
  });

  it('skips when another instance holds the lock', async () => {
    const { service, redis, triage } = build();
    redis.isConnected.mockReturnValue(true);
    redis.acquireLock.mockResolvedValue(false);

    await service.tick();

    expect(triage.rescore).not.toHaveBeenCalled();
  });

  it('never lets one sweep overlap another', async () => {
    const { service, triage } = build();
    // One shared gate: every call blocks on it, and releasing unblocks them all.
    // A per-call promise would leave the sweep's second level hanging forever.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    triage.rescore.mockImplementation(async () => {
      await gate;
      return { transitions: [] };
    });

    const first = service.tick();
    // Let the first sweep get as far as it can before it blocks.
    await Promise.resolve();
    const callsBefore = triage.rescore.mock.calls.length;

    // Second tick fires while the first is still in flight; it must add nothing.
    await service.tick();
    expect(triage.rescore.mock.calls.length).toBe(callsBefore);

    release();
    await first;
  });

  it('survives a failing sweep so the timer keeps running', async () => {
    const { service, triage } = build();
    triage.rescore.mockRejectedValue(new Error('database gone'));

    await expect(service.tick()).resolves.toBeUndefined();

    // The in-process guard must be released, or every later tick is skipped.
    triage.rescore.mockResolvedValue({ transitions: [] });
    await service.tick();
    expect(triage.rescore).toHaveBeenCalledTimes(3);
  });

  it('scores wards only under the LGAs already at risk', async () => {
    const { service, triage, triageScoreFindMany } = build();
    triageScoreFindMany.mockResolvedValue([
      { scopeId: 'lga-1' },
      { scopeId: 'lga-2' },
    ]);

    await service.tick();

    expect(triage.rescoreChildren).toHaveBeenCalledTimes(2);
    const calls = triage.rescoreChildren.mock.calls as unknown[][];
    expect(calls.map((call) => call[1])).toEqual(['WARD', 'WARD']);
    expect(calls.map((call) => call[2])).toEqual(['lga-1', 'lga-2']);

    // Only HIGH and CRITICAL LGAs qualify, and the pass is capped.
    const [[query]] = triageScoreFindMany.mock.calls as Array<
      [{ where: { riskLevel: { in: string[] } }; take: number }]
    >;
    expect(query.where.riskLevel.in).toEqual(['HIGH', 'CRITICAL']);
    expect(query.take).toBeLessThanOrEqual(20);
  });

  it('skips the ward pass entirely when nothing is at risk', async () => {
    const { service, triage } = build();
    await service.tick();
    expect(triage.rescoreChildren).not.toHaveBeenCalled();
  });

  it('does not let a ward-pass failure fail the whole sweep', async () => {
    const { service, triage, triageScoreFindMany } = build();
    triageScoreFindMany.mockResolvedValue([{ scopeId: 'lga-1' }]);
    triage.rescoreChildren.mockRejectedValue(new Error('ward query blew up'));

    await expect(service.tick()).resolves.toBeUndefined();

    // The state and LGA boards were already written; they must still count.
    expect(triage.rescore).toHaveBeenCalledTimes(2);
    // And the guard must be released so later ticks still run.
    await service.tick();
    expect(triage.rescore).toHaveBeenCalledTimes(4);
  });


  it('drains dirty scopes without touching the full sweep', async () => {
    const { service, triage, trigger } = build();
    trigger.takeDirty.mockReturnValue([
      { campaignId: 'campaign-1', level: 'LGA', scopeIds: ['lga-1', 'lga-2'] },
    ]);

    await service.drainTick();

    expect(triage.rescoreScopes).toHaveBeenCalledTimes(1);
    const call = triage.rescoreScopes.mock.calls[0] as unknown[];
    expect(call[1]).toBe('LGA');
    expect(call[2]).toEqual(['lga-1', 'lga-2']);
    // The full sweep must not run as a side effect of draining.
    expect(triage.rescore).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is dirty', async () => {
    const { service, triage } = build();
    await service.drainTick();
    expect(triage.rescoreScopes).not.toHaveBeenCalled();
  });

  it('never lets one drain overlap another', async () => {
    const { service, triage, trigger } = build();
    trigger.takeDirty.mockReturnValue([
      { campaignId: 'campaign-1', level: 'STATE', scopeIds: ['s1'] },
    ]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    triage.rescoreScopes.mockImplementation(async () => {
      await gate;
      return { scored: 1, changed: 0, unchanged: 1, transitions: [] };
    });

    const first = service.drainTick();
    await Promise.resolve();
    await service.drainTick();
    expect(triage.rescoreScopes).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('prunes polling-unit snapshots once per sweep day', async () => {
    const { service, snapshotDeleteMany } = build();

    await service.tick();
    expect(snapshotDeleteMany).toHaveBeenCalledTimes(1);
    const where = (snapshotDeleteMany.mock.calls[0][0] as { where: { level: string } }).where;
    // Ward and above are the sparkline history and must survive.
    expect(where.level).toBe('POLLING_UNIT');

    // Same day again: no second prune.
    await service.tick();
    expect(snapshotDeleteMany).toHaveBeenCalledTimes(1);
  });

  it('honours a configured interval and ignores nonsense below the floor', () => {
    const spy = jest.spyOn(global, 'setInterval').mockReturnValue({
      unref: jest.fn(),
    } as never);

    // Two timers are registered now: the sweep first, then the dirty drain.
    // Assert on the sweep specifically rather than on whichever ran last.
    build({
      TRIAGE_SWEEP_ENABLED: 'true',
      TRIAGE_SWEEP_INTERVAL_SEC: '120',
      TRIAGE_DIRTY_DRAIN_SEC: '30',
    }).service.onModuleInit();
    expect(spy).toHaveBeenNthCalledWith(1, expect.any(Function), 120_000);
    expect(spy).toHaveBeenNthCalledWith(2, expect.any(Function), 30_000);

    spy.mockClear();
    build({
      TRIAGE_SWEEP_ENABLED: 'true',
      TRIAGE_SWEEP_INTERVAL_SEC: '5',
      TRIAGE_DIRTY_DRAIN_SEC: '1',
    }).service.onModuleInit();
    // Both nonsense values fall back to their floors.
    expect(spy).toHaveBeenNthCalledWith(1, expect.any(Function), 900_000);
    expect(spy).toHaveBeenNthCalledWith(2, expect.any(Function), 45_000);

    spy.mockRestore();
  });
});
