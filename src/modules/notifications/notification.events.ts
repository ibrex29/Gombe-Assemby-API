import {
  NotificationPriority,
  NotificationType,
} from '@electromon/shared';

export const NOTIFICATION_DISPATCH_EVENT = 'notification.dispatch';

export type NotificationEntityType =
  | 'COLLATION_RESULT'
  | 'FIELD_REPORT'
  | 'SITUATION_UPDATE'
  | 'TRIAGE_SCORE'
  | 'PULSE_REMINDER';

export type ResolvedRecipient = {
  userId: string;
  sendPush: boolean;
  priority?: NotificationPriority;
};

export type NotificationDispatchPayload = {
  type: NotificationType;
  campaignId: string;
  actorUserId: string;
  entityType: NotificationEntityType;
  entityId: string;
  sourceEventId: string;
  sendPush: boolean;
  scopeName?: string;
  collationResult?: {
    level: string;
    scopeType: string;
    scopeId: string;
    submittedById?: string | null;
  };
  fieldReport?: {
    wardId?: string | null;
    pollingUnitId?: string | null;
    reportedById: string;
    isUrgent: boolean;
    incidentSeverity?: string | null;
    status?: string | null;
  };
  situationUpdate?: {
    pollingUnitId: string;
    isUrgent: boolean;
    status?: string | null;
  };
  /** Set for TRIAGE_RISK_RAISED / TRIAGE_RISK_CLEARED. */
  triage?: {
    level: string;
    scopeType: string;
    scopeId: string;
    fromRisk: string;
    toRisk: string;
    compositeScore: number;
    /** Top driver, generated from the numbers by the scoring engine. */
    driver?: string | null;
    stateId?: string | null;
    stateCode?: string | null;
  };
  /** Set for PULSE_REMINDER. Recipients are chosen by the scheduler or first-open nudge. */
  pulseReminder?: {
    audience: 'agent' | 'ward' | 'lga';
    slotId: string;
    silentCount?: number;
    totalAssigned?: number;
    wardId?: string;
    lgaId?: string;
  };
  explicitRecipients?: ResolvedRecipient[];
};
