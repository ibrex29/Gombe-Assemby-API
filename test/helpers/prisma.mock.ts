export type MockPrismaService = {
  $connect: jest.Mock;
  $disconnect: jest.Mock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
  getPoolStats: jest.Mock;
  user: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
  };
  campaign: {
    findUniqueOrThrow: jest.Mock;
    findUnique: jest.Mock;
  };
  campaignMembership: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  supportGroup: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  commitment: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    aggregate: jest.Mock;
  };
  volunteer: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
  };
  pollingUnit: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
  lGA: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
  ward: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  situationUpdate: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };
  pollingUnitPulse: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  fieldReport: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  collationResult: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  notification: {
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  deviceToken: {
    upsert: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  refreshToken: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  activityLog: {
    create: jest.Mock;
  };
  contest: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  stateAssemblyConstituency: {
    findMany: jest.Mock;
    count: jest.Mock;
    upsert: jest.Mock;
  };
  irevElectionConfig: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    upsert: jest.Mock;
    create: jest.Mock;
  };
  irevPuSnapshot: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
};

export function createMockPrismaService(): MockPrismaService {
  return {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    $transaction: jest.fn((fn) => fn(createMockPrismaService())),
    getPoolStats: jest.fn().mockReturnValue({ total: 0, idle: 0, waiting: 0 }),
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    campaign: {
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
    },
    campaignMembership: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    supportGroup: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    commitment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    volunteer: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    pollingUnit: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    lGA: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    ward: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    situationUpdate: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    pollingUnitPulse: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    fieldReport: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    collationResult: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    deviceToken: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    activityLog: {
      create: jest.fn(),
    },
    contest: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    stateAssemblyConstituency: {
      findMany: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
    },
    irevElectionConfig: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
    },
    irevPuSnapshot: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
}
