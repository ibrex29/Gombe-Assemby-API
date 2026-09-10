import { SetMetadata } from '@nestjs/common';
import { CampaignRole } from '@electromon/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: CampaignRole[]) => SetMetadata(ROLES_KEY, roles);

export const CURRENT_USER_KEY = 'currentUser';
