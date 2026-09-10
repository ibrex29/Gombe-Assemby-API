import { CampaignRole, ScopeType } from './enums';
export interface JwtPayload {
    sub: string;
    email: string;
    phoneNumber?: string | null;
    campaignId?: string;
    role?: CampaignRole;
    scopeType?: ScopeType;
    scopeId?: string;
}
export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
}
export interface ApiResponse<T> {
    success: boolean;
    data?: T;
    message?: string;
    error?: string;
}
