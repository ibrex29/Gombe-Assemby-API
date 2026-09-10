export type IrevFetchJob = {
  campaignId: string;
  contestId?: string;
  collationResultId?: string;
  pollingUnitId?: string;
  wardId?: string;
  attempt?: number;
  force?: boolean;
  /** OCR an existing cataloged snapshot without an agent collation result. */
  ocrOnly?: boolean;
};

/** Override per deployment (e.g. irev.fetch.pantamiyya) when sharing a RabbitMQ broker. */
export const IREV_FETCH_QUEUE = process.env.IREV_FETCH_QUEUE?.trim() || 'irev.fetch';
export const IREV_FETCH_EVENT = 'irev.fetch';
