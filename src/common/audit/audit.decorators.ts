import { SetMetadata } from '@nestjs/common';

export const SKIP_AUDIT_KEY = 'skipAudit';
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);

export const AUDIT_ACTION_KEY = 'auditAction';
export const AuditAction = (action: string) => SetMetadata(AUDIT_ACTION_KEY, action);
