import * as bcrypt from 'bcrypt';
import { CampaignRole, ScopeType } from '@electromon/shared';
import type { JwtPayload } from '@electromon/shared';

export const TEST_PASSWORD = 'ChangeMe123!';

export const TEST_CAMPAIGN_ID = 'campaign-test-001';
export const TEST_USER_ID = 'user-test-001';
export const TEST_LGA_ID = 'lga-test-001';
export const TEST_WARD_ID = 'ward-test-001';
export const TEST_PU_ID = 'pu-test-001';
export const TEST_GROUP_ID = 'group-test-001';

export const testPasswordHash = bcrypt.hashSync(TEST_PASSWORD, 4);

export const testMembership = {
  userId: TEST_USER_ID,
  campaignId: TEST_CAMPAIGN_ID,
  role: CampaignRole.CAMPAIGN_DIRECTOR,
  scopeType: ScopeType.CAMPAIGN,
  scopeId: TEST_CAMPAIGN_ID,
  isActive: true,
};

export const testUserRecord = {
  id: TEST_USER_ID,
  email: 'director@electromon.ng',
  phoneNumber: '+2348000000001',
  passwordHash: testPasswordHash,
  firstName: 'Campaign',
  lastName: 'Director',
  otherNames: null,
  isActive: true,
  mfaEnabled: false,
  mfaSecret: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  memberships: [testMembership],
};

export const testJwtPayload: JwtPayload = {
  sub: TEST_USER_ID,
  email: 'director@electromon.ng',
  phoneNumber: '+2348000000001',
  campaignId: TEST_CAMPAIGN_ID,
  role: CampaignRole.CAMPAIGN_DIRECTOR,
  scopeType: ScopeType.CAMPAIGN,
  scopeId: TEST_CAMPAIGN_ID,
};

export const testSupportGroup = {
  id: TEST_GROUP_ID,
  campaignId: TEST_CAMPAIGN_ID,
  name: 'Hadejia Youth Forum',
  category: 'YOUTH' as const,
  leaderName: 'Ibrahim Musa',
  leaderPhone: '+2348012345678',
  leaderEmail: null,
  memberCount: 120,
  lgaId: TEST_LGA_ID,
  areaOfOperation: 'Hadejia',
  verificationStatus: 'ACTIVE' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  lga: { id: TEST_LGA_ID, name: 'Hadejia' },
};

export const testPollingUnit = {
  id: TEST_PU_ID,
  code: 'JI-HD-001',
  name: 'Hadejia Central PU 001',
  wardId: TEST_WARD_ID,
  latitude: 12.45,
  longitude: 10.04,
  strengthAssessment: 'STRONG' as const,
  status: 'ACTIVE' as const,
  assignedAgentId: null,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ward: {
    id: TEST_WARD_ID,
    name: 'Hadejia Ward A',
    lga: { id: TEST_LGA_ID, name: 'Hadejia' },
  },
};
