import { CampaignRole, ScopeType } from './enums';

export enum CollationLevel {
  POLLING_UNIT = 'POLLING_UNIT',
  WARD = 'WARD',
  LGA = 'LGA',
  CONSTITUENCY = 'CONSTITUENCY',
  STATE = 'STATE',
  NATIONAL = 'NATIONAL',
}

export enum CollationResultStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export const NATIONAL_SCOPE_ID = 'NGA';

export const COLLATION_ROLES: CampaignRole[] = [
  CampaignRole.POLLING_AGENT,
  CampaignRole.WARD_RA_OFFICER,
  CampaignRole.LGA_COLLATION_OFFICER,
  CampaignRole.STATE_COLLATION_OFFICER,
  CampaignRole.NATIONAL_COLLATION_OFFICER,
];

/** System controllers — full read access across the campaign */
export const CAMPAIGN_ADMIN_ROLES: CampaignRole[] = [
  CampaignRole.CAMPAIGN_DIRECTOR,
  CampaignRole.CANDIDATE,
];

export function isCampaignAdminRole(role?: CampaignRole | string | null): boolean {
  return (
    role === CampaignRole.CAMPAIGN_DIRECTOR || role === CampaignRole.CANDIDATE
  );
}

/** Collation officers + campaign admins (read endpoints) */
export const COLLATION_READ_ROLES: CampaignRole[] = [
  ...COLLATION_ROLES,
  ...CAMPAIGN_ADMIN_ROLES,
];

/** One role per collation level (legacy dual roles map to the same level for old rows) */
export const ROLE_TO_COLLATION_LEVEL: Partial<Record<CampaignRole, CollationLevel>> = {
  [CampaignRole.POLLING_AGENT]: CollationLevel.POLLING_UNIT,
  [CampaignRole.POLLING_UNIT_OFFICER]: CollationLevel.POLLING_UNIT, // legacy
  [CampaignRole.WARD_RA_OFFICER]: CollationLevel.WARD,
  [CampaignRole.WARD_COORDINATOR]: CollationLevel.WARD, // legacy
  [CampaignRole.LGA_COLLATION_OFFICER]: CollationLevel.LGA,
  [CampaignRole.LGA_COORDINATOR]: CollationLevel.LGA, // legacy
  [CampaignRole.STATE_COLLATION_OFFICER]: CollationLevel.STATE,
  [CampaignRole.STATE_COORDINATOR]: CollationLevel.STATE, // legacy
  [CampaignRole.NATIONAL_COLLATION_OFFICER]: CollationLevel.NATIONAL,
};

export const LEVEL_TO_SCOPE_TYPE: Record<CollationLevel, ScopeType> = {
  [CollationLevel.POLLING_UNIT]: ScopeType.POLLING_UNIT,
  [CollationLevel.WARD]: ScopeType.WARD,
  [CollationLevel.LGA]: ScopeType.LGA,
  [CollationLevel.CONSTITUENCY]: ScopeType.CONSTITUENCY,
  [CollationLevel.STATE]: ScopeType.STATE,
  [CollationLevel.NATIONAL]: ScopeType.NATIONAL,
};

export const COLLATION_HIERARCHY: CollationLevel[] = [
  CollationLevel.POLLING_UNIT,
  CollationLevel.WARD,
  CollationLevel.LGA,
  CollationLevel.STATE,
  CollationLevel.NATIONAL,
];

export const ASSEMBLY_COLLATION_HIERARCHY: CollationLevel[] = [
  CollationLevel.POLLING_UNIT,
  CollationLevel.WARD,
  CollationLevel.CONSTITUENCY,
  CollationLevel.STATE,
  CollationLevel.NATIONAL,
];

export interface CollationDashboardMeta {
  level: CollationLevel;
  levelLabel: string;
  levelOrder: number;
  scopeType: ScopeType;
  scopeId?: string;
  scopeName?: string;
  canSubmit: boolean;
  canApprove: boolean;
  canComment: boolean;
  canRequestCorrection: boolean;
  approvesFromLevel?: CollationLevel;
  submitsToLevel?: CollationLevel;
  route: string;
}

const LEVEL_META: Record<
  CollationLevel,
  Omit<CollationDashboardMeta, 'scopeType' | 'scopeId' | 'scopeName'>
> = {
  [CollationLevel.POLLING_UNIT]: {
    level: CollationLevel.POLLING_UNIT,
    levelLabel: 'Polling Unit (PU)',
    levelOrder: 1,
    canSubmit: true,
    canApprove: false,
    canComment: false,
    canRequestCorrection: false,
    submitsToLevel: CollationLevel.WARD,
    route: '/dashboard/polling-unit',
  },
  [CollationLevel.WARD]: {
    level: CollationLevel.WARD,
    levelLabel: 'Ward / Registration Area (RA)',
    levelOrder: 2,
    canSubmit: false,
    canApprove: true,
    canComment: false,
    canRequestCorrection: false,
    approvesFromLevel: CollationLevel.POLLING_UNIT,
    submitsToLevel: CollationLevel.LGA,
    route: '/dashboard/ward',
  },
  [CollationLevel.LGA]: {
    level: CollationLevel.LGA,
    levelLabel: 'Local Government Area (LGA)',
    levelOrder: 3,
    canSubmit: false,
    canApprove: false,
    canComment: true,
    canRequestCorrection: true,
    approvesFromLevel: CollationLevel.WARD,
    route: '/dashboard/lga',
  },
  [CollationLevel.CONSTITUENCY]: {
    level: CollationLevel.CONSTITUENCY,
    levelLabel: 'State Constituency',
    levelOrder: 3,
    canSubmit: false,
    canApprove: false,
    canComment: true,
    canRequestCorrection: true,
    approvesFromLevel: CollationLevel.WARD,
    submitsToLevel: CollationLevel.STATE,
    route: '/dashboard/lga',
  },
  [CollationLevel.STATE]: {
    level: CollationLevel.STATE,
    levelLabel: 'State Collation Centre',
    levelOrder: 4,
    canSubmit: true,
    canApprove: false,
    canComment: true,
    canRequestCorrection: true,
    approvesFromLevel: CollationLevel.LGA,
    submitsToLevel: CollationLevel.NATIONAL,
    route: '/dashboard/state',
  },
  [CollationLevel.NATIONAL]: {
    level: CollationLevel.NATIONAL,
    levelLabel: 'National Collation Centre (Abuja)',
    levelOrder: 5,
    canSubmit: true,
    canApprove: false,
    canComment: true,
    canRequestCorrection: true,
    approvesFromLevel: CollationLevel.STATE,
    route: '/dashboard/national',
  },
};

export function getCollationLevelForRole(role?: CampaignRole): CollationLevel | undefined {
  if (!role) return undefined;
  return ROLE_TO_COLLATION_LEVEL[role];
}

export function buildDashboardMeta(
  role: CampaignRole,
  scopeType?: ScopeType,
  scopeId?: string | null,
  scopeName?: string,
): CollationDashboardMeta | undefined {
  const level = getCollationLevelForRole(role);
  if (!level) return undefined;

  const meta = LEVEL_META[level];
  return {
    ...meta,
    scopeType: scopeType ?? LEVEL_TO_SCOPE_TYPE[level],
    scopeId: scopeId ?? undefined,
    scopeName,
  };
}

export function getParentLevel(level: CollationLevel): CollationLevel | undefined {
  const index = COLLATION_HIERARCHY.indexOf(level);
  return index > 0 ? COLLATION_HIERARCHY[index - 1] : undefined;
}

export function getChildLevel(level: CollationLevel): CollationLevel | undefined {
  const index = COLLATION_HIERARCHY.indexOf(level);
  return index >= 0 && index < COLLATION_HIERARCHY.length - 1
    ? COLLATION_HIERARCHY[index + 1]
    : undefined;
}
