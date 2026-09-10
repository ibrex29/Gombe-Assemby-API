import { NotificationPriority, NotificationType } from '@electromon/shared';

export type NotificationCopy = {
  title: string;
  body: string;
  priority: NotificationPriority;
  route: string;
};

export function buildNotificationCopy(
  type: NotificationType,
  scopeName?: string,
  options?: {
    urgent?: boolean;
    /** Collation level a comment was left at, for the result cases. */
    level?: string;
    /** Risk band a scope moved into or out of, for the triage cases. */
    riskLevel?: string;
    /** Composite score at the moment of the move. */
    score?: number;
    /** Top driver, already generated from the numbers by the engine. */
    reason?: string;
    pulseAudience?: 'agent' | 'ward' | 'lga';
    silentCount?: number;
    totalAssigned?: number;
  },
): NotificationCopy {
  const name = scopeName?.trim() || 'a polling unit';

  switch (type) {
    case NotificationType.RESULT_SUBMITTED:
      return {
        title: 'New PU result submitted',
        body: `${name} submitted results for review.`,
        priority: NotificationPriority.HIGH,
        route: 'ward.resultDetail',
      };
    case NotificationType.RESULT_APPROVED:
      return {
        title: 'Result approved',
        body: 'Your polling unit result was approved.',
        priority: NotificationPriority.HIGH,
        route: 'agent.resultStatus',
      };
    case NotificationType.RESULT_RETURNED:
      return {
        title: 'Result returned for correction',
        body: `${name} was returned. Open the app to see the reason.`,
        priority: NotificationPriority.HIGH,
        route: 'agent.resultStatus',
      };
    case NotificationType.WARD_RETURNED_BY_LGA:
      return {
        title: 'Ward rollup returned',
        body: 'LGA returned your ward totals.',
        priority: NotificationPriority.HIGH,
        route: 'ward.rollup',
      };
    case NotificationType.WARD_FORWARDED_TO_LGA:
      return {
        title: 'Ward figures are live',
        body: `${name} was approved at ward level and is now on the Situation Room.`,
        priority: NotificationPriority.NORMAL,
        route: 'lga.wardRollup',
      };
    case NotificationType.RESULT_COMMENTED:
      return {
        title: 'New comment on a result',
        body: `A reviewer commented on ${name}.`,
        priority: NotificationPriority.NORMAL,
        route: options?.level === 'LGA' ? 'lga.wardRollup' : 'ward.rollup',
      };
    case NotificationType.INCIDENT_REPORTED:
      return {
        title: 'New incident reported',
        body: `An incident was reported at ${name}.`,
        priority: options?.urgent ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
        route: 'ward.incidentDetail',
      };
    case NotificationType.INCIDENT_RESOLVED:
      return {
        title: 'Incident resolved',
        body: 'Your incident report was marked resolved.',
        priority: NotificationPriority.NORMAL,
        route: 'agent.incidentDetail',
      };
    case NotificationType.INCIDENT_ESCALATED:
      return {
        title: 'Incident escalated',
        body: `An incident at ${name} was escalated to LGA.`,
        priority: NotificationPriority.HIGH,
        route: 'lga.incidentDetail',
      };
    case NotificationType.SITUATION_UPDATE:
      return {
        title: options?.urgent ? 'Urgent pulse at the unit' : 'Field pulse update',
        body: options?.urgent
          ? `${name} needs attention — BVAS, disruption, or heavy opposition play.`
          : `A process update was posted at ${name}.`,
        priority: options?.urgent ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
        route: 'ward.dashboard',
      };
    case NotificationType.TRIAGE_RISK_RAISED: {
      // Score and reason come from the engine, which generates its drivers from
      // the numbers — so this copy stays deterministic rather than descriptive.
      const band = options?.riskLevel ?? 'HIGH';
      const score =
        typeof options?.score === 'number' ? ` (score ${Math.round(options.score)})` : '';
      const reason = options?.reason ? ` — ${options.reason}` : '';
      return {
        title: `${name} is now ${band}`,
        body: `${name} moved to ${band} risk${score}${reason}.`,
        priority:
          band === 'CRITICAL'
            ? NotificationPriority.HIGH
            : NotificationPriority.NORMAL,
        route: 'admin.earlyWarning',
      };
    }
    case NotificationType.TRIAGE_RISK_CLEARED: {
      const band = options?.riskLevel ?? 'MEDIUM';
      return {
        title: `${name} dropped back to ${band}`,
        body: `Risk at ${name} eased to ${band}.`,
        priority: NotificationPriority.NORMAL,
        route: 'admin.earlyWarning',
      };
    }
    case NotificationType.PULSE_REMINDER: {
      const silent = options?.silentCount ?? 0;
      const total = options?.totalAssigned ?? 0;
      if (options?.pulseAudience === 'ward') {
        return {
          title: 'Status update due',
          body:
            silent > 0
              ? `${silent} of ${total || silent} unit${silent === 1 ? '' : 's'} in your ward have not opened the app.`
              : 'Ask every polling unit in your ward to open the app if they have arrived.',
          priority: silent > 0 ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
          route: 'ward.pulseUnits',
        };
      }
      if (options?.pulseAudience === 'lga') {
        return {
          title: 'Status update due',
          body:
            silent > 0
              ? `${silent} of ${total || silent} unit${silent === 1 ? '' : 's'} in your LGA have not opened the app.`
              : 'Ask wards in your LGA to check units that have not opened the app.',
          priority: silent > 0 ? NotificationPriority.HIGH : NotificationPriority.NORMAL,
          route: 'lga.pulseUnits',
        };
      }
      return {
        title: 'Send your status update',
        body: 'Tap All fine if nothing change.',
        priority: NotificationPriority.HIGH,
        route: 'agent.pulseUpdate',
      };
    }
    return {
      title: 'Notification',
      body: name,
      priority: NotificationPriority.NORMAL,
      route: 'ward.dashboard',
    };
  }
}
