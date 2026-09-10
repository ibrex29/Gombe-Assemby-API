import { CampaignRole } from './enums';
import { CollationLevel, getCollationLevelForRole } from './collation';

export interface DashboardNavItem {
  href: string;
  label: string;
  icon?: string;
}

const ADMIN_NAV: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/lgas', label: 'Local Governments' },
  { href: '/dashboard/polling-stations', label: 'Polling Stations' },
  { href: '/dashboard/results', label: 'Results' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/situation-room', label: 'Situation Room' },
  { href: '/dashboard/analytics', label: 'Analytics' },
];

const STATE_NAV: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/lgas', label: 'Local Governments' },
  { href: '/dashboard/results', label: 'Results' },
];

const LGA_NAV: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/lga-review', label: 'LGA Review' },
  { href: '/dashboard/my-lga', label: 'Wards' },
  { href: '/dashboard/polling-stations', label: 'Polling Stations' },
  { href: '/dashboard/agents', label: 'Agents' },
];

const WARD_NAV: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/ward-review', label: 'Ward Review' },
  { href: '/dashboard/polling-stations', label: 'Polling Stations' },
  { href: '/dashboard/agents', label: 'Agents' },
];

const PU_NAV: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/my-unit', label: 'My Polling Unit' },
  { href: '/dashboard/results', label: 'Results' },
];

const NATIONAL_NAV: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/dashboard/lgas', label: 'Local Governments' },
  { href: '/dashboard/results', label: 'Results' },
];

export function getNavItemsForRole(role?: string): DashboardNavItem[] {
  switch (role) {
    case CampaignRole.NATIONAL_COLLATION_OFFICER:
      return NATIONAL_NAV;
    case CampaignRole.STATE_COLLATION_OFFICER:
      return STATE_NAV;
    case CampaignRole.LGA_COLLATION_OFFICER:
      return LGA_NAV;
    case CampaignRole.WARD_RA_OFFICER:
      return WARD_NAV;
    case CampaignRole.POLLING_AGENT:
      return PU_NAV;
    case CampaignRole.CAMPAIGN_DIRECTOR:
    case CampaignRole.CANDIDATE:
      return ADMIN_NAV;
    default:
      return STATE_NAV;
  }
}

export function getDefaultDashboardPath(role?: string): string {
  const level = role ? getCollationLevelForRole(role as CampaignRole) : undefined;

  switch (level) {
    case CollationLevel.POLLING_UNIT:
      return '/dashboard/my-unit';
    case CollationLevel.WARD:
      return '/dashboard/ward-review';
    case CollationLevel.CONSTITUENCY:
    case CollationLevel.LGA:
      return '/dashboard/lga-review';
    case CollationLevel.STATE:
    case CollationLevel.NATIONAL:
      return '/dashboard/lgas';
    default:
      return '/dashboard';
  }
}
