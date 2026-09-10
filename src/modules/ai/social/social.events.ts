/** RabbitMQ queue for sentiment analysis of ingested posts. */
export const AI_SOCIAL_ANALYZE_QUEUE = 'ai.social.analyze';

/** In-process fallback event, used when RabbitMQ is unavailable. */
export const AI_SOCIAL_ANALYZE_EVENT = 'ai.social.analyze';

/** Dead-letter exchange for AI jobs that fail twice. */
export const AI_DEAD_LETTER_EXCHANGE = 'ai.dlx';
export const AI_SOCIAL_DEAD_QUEUE = 'ai.social.dead';

export interface SocialAnalyzeJob {
  campaignId: string;
  postIds: string[];
}
