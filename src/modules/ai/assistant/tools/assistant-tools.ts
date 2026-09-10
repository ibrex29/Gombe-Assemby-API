import { CollationLevel, JwtPayload } from '@electromon/shared';
import { CollationBrowseService } from '../../../collation/collation-browse.service';
import { LlmToolDefinition } from '../../core/llm/llm.types';
import {
  CHART_METRICS,
  ChartRequest,
  ChartSpec,
  buildChart,
} from '../charts/chart-builder';
import {
  EvidencePhoto,
  EvidenceService,
  toEvidenceDigest,
} from '../evidence/evidence.service';
import { AgentsService } from '../../../agents/agents.service';
import { PulseforgeSyncService } from '../../social/pulseforge/pulseforge-sync.service';
import { TriageService } from '../../triage/triage.service';
import { SCHEMA_DESCRIPTION } from '../sql/allowlist';
import { ReadonlyDbService } from '../sql/readonly-db.service';
import { sanitizeSql } from '../sql/sql-sandbox';

/** One place's responsibility chain, rendered by the client from real data. */
export interface ContactCard {
  place: string;
  level: string;
  levels: Array<{
    level: string;
    name: string;
    contacts: Array<{
      name: string;
      role: string;
      phone: string | null;
      email: string | null;
      accountActive: boolean;
    }>;
  }>;
  unassignedLevels: string[];
}

/** Emitted to the client so the user sees what the assistant is doing. */
export type ToolStatusEmitter = (label: string, tool: string) => void;

export interface ToolContext {
  user: JwtPayload;
  campaignId: string;
  browse: CollationBrowseService;
  readonlyDb: ReadonlyDbService;
  evidence: EvidenceService;
  triage: TriageService;
  agents: AgentsService;
  social: PulseforgeSyncService;
  emit: ToolStatusEmitter;
  /**
   * Side channels back to the response. Photos and charts travel to the client
   * as structured data rather than through the model's text, so their URLs and
   * numbers cannot be invented.
   */
  attachPhotos: (photos: EvidencePhoto[]) => EvidencePhoto[];
  attachChart: (chart: ChartSpec) => void;
  /**
   * Contact cards travel to the client as data, never through the model's
   * text. A model asked to retype `+2348132000001` will eventually write
   * `...002`, and a wrong number during an incident is worse than none.
   */
  attachContacts: (card: ContactCard) => void;
  /** Raw tool outputs from this turn, so charts can be built from real data. */
  toolResults: Map<string, unknown>;
}

/** Everything a tool needs except the per-turn collectors. */
export type ToolContextBase = Omit<
  ToolContext,
  'attachPhotos' | 'attachChart' | 'attachContacts' | 'toolResults'
>;

export interface AssistantTool {
  definition: LlmToolDefinition;
  /** Throws on failure; the loop turns that into a tool error for the model. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const runSql: AssistantTool = {
  definition: {
    name: 'run_sql',
    description: [
      'Run one read-only PostgreSQL SELECT against the campaign database and get the rows back.',
      'Use this for anything the other tools do not cover: filtered lists, group-bys, turnout,',
      'timing, support groups, volunteers, commitments, or specific wards and polling units.',
      'The query is validated before it runs; if it is rejected, read the error and rewrite it.',
      '',
      SCHEMA_DESCRIPTION,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'A single PostgreSQL SELECT statement.',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const sql = typeof args.sql === 'string' ? args.sql : '';
    if (!sql.trim()) {
      throw new Error('No SQL provided.');
    }
    ctx.emit('Querying the campaign database', 'run_sql');
    // Only the sanitised rewrite is executed, never the model's own text.
    const safeSql = sanitizeSql(sql);
    const rows = await ctx.readonlyDb.runSandboxedQuery(
      safeSql,
      ctx.campaignId,
    );
    return { rowCount: rows.length, rows };
  },
};

/**
 * Trims the race payload before it reaches the model. The full response repeats
 * the same LGA rows in four derived lists, which burns context without adding
 * information — and everything kept here is also the grounding haystack.
 */
export function toRaceSummaryToolResult(
  raw: Awaited<ReturnType<CollationBrowseService['getRaceAnalytics']>>,
) {
  // Nationally the underlying service returns one row per STATE; inside a state
  // it returns one row per LGA. It reports which via geographyLevel/unitLabel, so
  // the rows are renamed here to `units` — calling them `lgas` at national scope
  // is exactly how a model ends up describing states as LGAs.
  const geographyLevel = raw.geographyLevel ?? 'LGA';
  const unitLabel = raw.unitLabel ?? 'LGAs';

  return {
    scopeName: raw.stateName,
    geographyLevel,
    unitLabel,
    clientPartyCode: raw.clientPartyCode,
    summary: {
      ...raw.summary,
      // summary.lgaCount counts whatever unit the rows are, so name it plainly.
      unitCount: raw.summary.lgaCount,
    },
    partyStandings: raw.partyStandings.map((party) => ({
      code: party.code,
      name: party.name,
      votes: party.votes,
      sharePercent: party.share,
    })),
    // Pre-rolled party totals per geopolitical zone so make_chart can draw
    // zone donuts without shipping every state's full party vector to the model.
    zonePartyStandings: buildZonePartyStandings(raw.lgas),
    units: raw.lgas.map((unit) => ({
      name: unit.name,
      // Present only on national rows; lets zone roll-ups come from the data.
      zone: unit.zone ?? undefined,
      outcome: unit.outcome,
      leadingParty: unit.leadingParty,
      margin: unit.margin,
      totalVotes: unit.totalVotes,
      clientVotes: unit.clientVotes,
      sharePercent: unit.share,
      reportingPercent: unit.reporting.percent,
      resultStatus: unit.resultStatus,
    })),
  };
}

/** Aggregate party votes for each geopolitical zone present on the rows. */
export function buildZonePartyStandings(
  units: Array<{
    zone?: string | null;
    parties?: Record<string, number>;
    name?: string;
  }>,
): Record<
  string,
  Array<{ code: string; name: string; votes: number; sharePercent: number }>
> {
  const totalsByZone = new Map<string, Record<string, number>>();

  for (const unit of units) {
    const zone = unit.zone?.trim();
    if (!zone || !unit.parties) continue;
    const bucket = totalsByZone.get(zone) ?? {};
    for (const [code, votes] of Object.entries(unit.parties)) {
      if (typeof votes !== 'number' || !Number.isFinite(votes)) continue;
      bucket[code] = (bucket[code] ?? 0) + votes;
    }
    totalsByZone.set(zone, bucket);
  }

  const out: Record<
    string,
    Array<{ code: string; name: string; votes: number; sharePercent: number }>
  > = {};

  for (const [zone, totals] of totalsByZone) {
    const sum = Object.values(totals).reduce((acc, n) => acc + n, 0);
    out[zone] = Object.entries(totals)
      .map(([code, votes]) => ({
        code,
        name: code,
        votes,
        sharePercent: sum > 0 ? Math.round((votes / sum) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.votes - a.votes);
  }

  return out;
}

const raceSummary: AssistantTool = {
  definition: {
    name: 'get_race_summary',
    description: [
      'Preferred source for standings: who is winning or losing, margins, vote share, overall',
      'totals, polling-unit reporting coverage, and open incident counts, broken down by',
      'geography. On a national campaign the rows are STATES; inside a single state they are',
      'LGAs — read the geographyLevel and unitLabel fields and describe them accordingly.',
      'National rows carry a zone field (North West, South East, ...) — group by it for',
      'regional questions instead of assigning states to zones yourself.',
      'Use this before writing SQL about results — it applies the campaign win/loss rules',
      'consistently with the Situation Room dashboards.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async execute(_args, ctx) {
    ctx.emit('Computing the race summary', 'get_race_summary');
    const raw = await ctx.browse.getRaceAnalytics(ctx.user);
    return toRaceSummaryToolResult(raw);
  },
};

const irevAttention: AssistantTool = {
  definition: {
    name: 'get_irev_attention',
    description: [
      'Ranked IReV hold sheets: client-party votes in dispute versus official INEC scans,',
      'document replacements, ward clusters, and what changed in the last 20 minutes.',
      'Use for questions about IReV mismatches, official scan disagreements, replacements,',
      'or which polling units to review next. These are review flags, not findings of fraud.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async execute(_args, ctx) {
    ctx.emit('Ranking IReV hold sheets', 'get_irev_attention');
    return ctx.browse.getIrevAttentionBrief(ctx.user);
  },
};

const incidentHotspots: AssistantTool = {
  definition: {
    name: 'get_incident_hotspots',
    description: [
      'Where unresolved incidents are concentrated, by LGA, weighted by severity',
      '(CRITICAL counts 4, HIGH 3, MEDIUM 2, LOW 1). Use for questions about where trouble is,',
      'which areas need attention, or how severe the incident picture is.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async execute(_args, ctx) {
    ctx.emit('Checking incident hotspots', 'get_incident_hotspots');
    return ctx.browse.getIncidentHotspots(ctx.user);
  },
};

const evidencePhotos: AssistantTool = {
  definition: {
    name: 'get_evidence_photos',
    description: [
      'Fetch photo evidence and show it to the user in the chat: EC8A result sheets, or',
      'photos attached to incident reports. Use it whenever someone asks to see, check, or',
      'verify something visually — "show me the EC8A for that unit", "any photos from the',
      'Kano incidents".',
      'You receive captions and a numbered ref for each photo, not the image itself. The',
      'photos are displayed to the user automatically; refer to them in prose as "photo 1",',
      '"photo 2". Never invent a link or a filename.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['incident', 'ec8a'],
          description:
            'incident = photos from field reports; ec8a = polling-unit result sheets.',
        },
        place: {
          type: 'string',
          description:
            'Optional place filter: a state, LGA or ward name, or a polling unit code such as 17-08-01-001.',
        },
        severity: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          description: 'Incidents only — restrict to this severity.',
        },
        limit: {
          type: 'number',
          description: 'How many photos (1-12, default 6).',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const kind = args.kind === 'ec8a' ? 'ec8a' : 'incident';
    ctx.emit(
      kind === 'ec8a' ? 'Pulling EC8A sheets' : 'Pulling incident photos',
      'get_evidence_photos',
    );

    const photos = await ctx.evidence.findPhotos(ctx.user, {
      kind,
      place: typeof args.place === 'string' ? args.place : undefined,
      severity: typeof args.severity === 'string' ? args.severity : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });

    if (photos.length === 0) {
      return { photos: [], note: 'No photos found for that filter.' };
    }

    // Registers the URLs for the client and returns them renumbered.
    const attached = ctx.attachPhotos(photos);
    return { photos: toEvidenceDigest(attached), shownToUser: true };
  },
};

const makeChart: AssistantTool = {
  definition: {
    name: 'make_chart',
    description: [
      'Render a chart of data you already fetched this turn, shown to the user inline on the desk.',
      'Call get_race_summary or get_incident_hotspots first, then chart it.',
      'You choose the view; the figures are taken from that tool result, so you do not',
      'supply any data yourself. Describe the chart briefly in prose — do not restate every',
      'value in a table as well.',
      'For party share / vote donuts or bars (national or by geopolitical zone), use',
      'source=party_standings with metric votes or sharePercent, and set zone when asked',
      '(e.g. zone="North West"). For state/LGA comparisons use source=race_summary;',
      'pass zone to limit those rows to one geopolitical zone.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'donut'] },
        source: {
          type: 'string',
          enum: ['race_summary', 'incident_hotspots', 'party_standings'],
          description:
            'race_summary = geography rows; party_standings = party vote/share; incident_hotspots = incident concentrations.',
        },
        metric: {
          type: 'string',
          description: `race_summary: ${CHART_METRICS.race_summary.join(', ')}. party_standings: ${CHART_METRICS.party_standings.join(', ')}. incident_hotspots: ${CHART_METRICS.incident_hotspots.join(', ')}.`,
        },
        zone: {
          type: 'string',
          description:
            'Optional geopolitical zone filter, e.g. "North West", "South East". Required mindset for zone party donuts.',
        },
        title: { type: 'string' },
        top: {
          type: 'number',
          description:
            'How many rows, highest first (2-15; default 8 for parties, 10 otherwise).',
        },
      },
      required: ['type', 'source', 'metric'],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    ctx.emit('Drawing the chart', 'make_chart');
    const chart = buildChart(args as unknown as ChartRequest, ctx.toolResults);
    ctx.attachChart(chart);
    return {
      shownToUser: true,
      title: chart.title,
      points: chart.series.length,
      // Echoed so the figures land in the grounding haystack too.
      series: chart.series,
    };
  },
};

const triageSnapshot: AssistantTool = {
  definition: {
    name: 'get_triage_risk',
    description: [
      'The risk board: which states or LGAs are winning, losing, or at risk, with a 0-100',
      'composite risk score and the reasons behind it. Use for "where are we in trouble",',
      '"what should we worry about", "which areas need attention".',
      'These scores are computed deterministically from results, incidents, reporting coverage,',
      'turnout and verification flags — report them as given, and never invent a score.',
      'An outlook of UNKNOWN means reporting is still too thin to call that scope; say so',
      'rather than substituting whoever is currently ahead.',
      'The result also carries the most recent risk movements — use those when asked',
      'what changed, what is new, or what has got worse since earlier.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['STATE', 'LGA'],
          description: 'Geography to report on. Defaults to STATE.',
        },
        riskLevel: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          description: 'Optional: only scopes at this risk level.',
        },
        limit: {
          type: 'number',
          description: 'How many rows, worst first (default 15).',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    ctx.emit('Reading the risk board', 'get_triage_risk');
    const level =
      args.level === 'LGA' ? CollationLevel.LGA : CollationLevel.STATE;
    const board = await ctx.triage.overview(
      ctx.user,
      level,
      args.riskLevel as never,
    );
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
    return {
      level: board.level,
      unitLabel: board.unitLabel,
      summary: board.summary,
      // Worst first; the rest are omitted rather than truncated silently.
      rows: board.rows.slice(0, limit),
      omitted: Math.max(0, board.rows.length - limit),
      // What moved, so "what changed tonight" is answerable without a
      // second tool: bands only, since a score drifting inside a band is
      // not news.
      recentTransitions: (board.recentTransitions ?? []).map((row) => ({
        name: row.name,
        from: row.fromRisk,
        to: row.toRisk,
        raised: row.raised,
        at: row.at,
        acknowledged: row.acknowledged,
      })),
    };
  },
};

/**
 * Who to call about a place.
 *
 * The one route by which the assistant may reach personal contact data, and it
 * exists as a typed tool rather than an allowlist entry on purpose: the SQL
 * sandbox reads text the campaign does not control — incident descriptions,
 * ward comments, later social posts — so anything reachable from generated SQL
 * is reachable by whoever wrote that text. Contacts are therefore fetched
 * through `AgentsService`, which applies the same role check as the Agents
 * page, rather than through a query the model composes.
 */
const scopeContacts: AssistantTool = {
  definition: {
    name: 'get_scope_contacts',
    description: [
      'Who is responsible for a place and how to reach them: the polling unit agent,',
      'ward coordinator, LGA and state officers, nearest first then up the chain.',
      'Use for "who is the agent at PU 32-02-03-001", "who runs Ahoada III",',
      '"who do I call about this incident", "who covers Kano".',
      'Accepts a polling unit code, or the name of a polling unit, ward, LGA or state.',
      'The phone numbers are shown to the user in a contact card automatically.',
      'Name the people and their roles in prose; never write a phone number or email yourself.',
      'If the tool reports nobody assigned, say the post is vacant — do not substitute',
      'someone from another level as though they were the assigned agent.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        place: {
          type: 'string',
          description:
            'Polling unit code or the name of a polling unit, ward, LGA or state.',
        },
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    // args is Record<string, unknown>; a non-string here would stringify to
    // "[object Object]" and be searched for literally.
    const place = typeof args.place === 'string' ? args.place.trim() : '';
    ctx.emit(`Looking up who covers ${place}`, 'get_scope_contacts');
    if (!place) {
      return { error: 'No place given.' };
    }

    const found = await ctx.agents.findScopeByLabel(place);

    if ('notFound' in found) {
      return {
        found: false,
        message: `No polling unit, ward, LGA or state matches "${place}".`,
      };
    }
    if ('ambiguous' in found) {
      // Returning the options beats picking one: "Ahoada" is three different
      // places, and guessing sends somebody to the wrong ward.
      return {
        found: false,
        ambiguous: found.ambiguous.map((option) => ({
          name: option.name,
          level: option.scopeType,
        })),
        message: `"${place}" matches more than one place. Ask which one is meant.`,
      };
    }

    const contacts = await ctx.agents.getScopeContacts(
      ctx.user,
      ctx.campaignId,
      found.match.scopeType,
      found.match.scopeId,
    );

    const card: ContactCard = {
      place: found.match.name,
      level: found.match.scopeType,
      levels: contacts.levels.map((level) => ({
        level: level.scopeType,
        name: level.name,
        contacts: level.contacts.map((contact) => ({
          name: contact.name,
          role: contact.role,
          phone: contact.phoneNumber,
          email: contact.email,
          accountActive: contact.isActive,
        })),
      })),
      unassignedLevels: contacts.unassigned,
    };
    ctx.attachContacts(card);

    // What comes back to the model carries names and roles but no phone number
    // or address: it has everything it needs to write the prose, and nothing it
    // could mis-transcribe. The card itself is rendered from the data above.
    return {
      found: true,
      place: card.place,
      level: card.level,
      rendered: 'A contact card is shown to the user with the numbers.',
      responsibility: card.levels.map((level) => ({
        level: level.level,
        name: level.name,
        people: level.contacts.map((contact) => ({
          name: contact.name,
          role: contact.role,
          reachable: contact.phone !== null && contact.accountActive,
        })),
      })),
      unassignedLevels: card.unassignedLevels,
    };
  },
};


/**
 * Public mood, from the campaign's own stored snapshots.
 *
 * Reads what the sync wrote rather than calling Pulseforge, so the assistant
 * and the risk board can never disagree about what the mood was.
 */
const socialMood: AssistantTool = {
  definition: {
    name: 'get_social_mood',
    description: [
      'Public mood from social listening: the negative/neutral/positive split for the country',
      'or for one state, with how many states have any reading at all.',
      'Use for "what is the public mood", "how negative is X", "what are people saying about us".',
      'Coverage is partial by design — a place with no posts reports that, and must never be',
      'described as calm. Report the coverage caveat whenever you quote a share.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          description: 'Optional state name or two-letter code. Omit for the country.',
        },
      },
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const state = typeof args.state === 'string' ? args.state.trim() : '';
    ctx.emit(state ? `Reading mood in ${state}` : 'Reading public mood', 'get_social_mood');

    if (state) {
      const board = await ctx.social.stateMood(ctx.campaignId, state);
      return {
        scope: board.state.name,
        summary: board.summary,
        coverage: board.coverage,
        worstLgas: board.lgas.slice(0, 5),
        note: board.summary
          ? null
          : `No social posts from ${board.state.name} yet — that is missing data, not calm.`,
      };
    }

    const board = await ctx.social.mood(ctx.campaignId);
    return {
      scope: 'National',
      national: board.national,
      coverage: board.coverage,
      worstStates: board.rows.slice(0, 6).map((row) => ({
        name: row.name,
        negativeShare: row.negativeShare,
        classified: row.classified,
        // Below this a share is arithmetic rather than a finding.
        thinSample: row.classified < 20,
      })),
      note: 'States absent from this list have no posts yet, not a calm mood.',
    };
  },
};

/** Story clusters, ranked by how fast they are growing. */
const narrativesTool: AssistantTool = {
  definition: {
    name: 'get_narratives',
    description: [
      'What stories are spreading right now, with volume, growth rate and share of voice.',
      'Use for "what is trending", "what is spreading", "what are people talking about".',
      'These are national: the upstream does not break narratives down by state, so do not',
      'claim a narrative belongs to one place.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async execute(_args, ctx) {
    ctx.emit('Reading what is spreading', 'get_narratives');
    const result = await ctx.social.narratives(8);
    if (!result.configured) {
      return { available: false, reason: 'Social listening is not connected.' };
    }
    return { available: true, scope: 'NATIONAL', narratives: result.rows };
  },
};

/** Pulseforge's own detections. Context, never a score input. */
const socialAlerts: AssistantTool = {
  definition: {
    name: 'get_social_alerts',
    description: [
      'Open flags raised by the social listening platform itself — misinformation clusters,',
      'polarising debates, sustained negative spikes. Use for "any social red flags",',
      '"what should we watch". These detections belong to a third party and are deliberately not',
      'part of the risk score; say so if asked whether they affect it.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  async execute(_args, ctx) {
    ctx.emit('Checking social flags', 'get_social_alerts');
    const result = await ctx.social.alerts();
    if (!result.configured) {
      return { available: false, reason: 'Social listening is not connected.' };
    }
    return {
      available: true,
      provenance: result.provenance,
      alerts: result.rows,
    };
  },
};

/**
 * Stance toward a named figure.
 *
 * Stance is not sentiment: an angry post can be supportive. Polarization is
 * what separates a divisive figure from a broadly disliked one, and the two
 * call for opposite responses.
 */
const stanceTool: AssistantTool = {
  definition: {
    name: 'get_stance',
    description: [
      'How people stand toward a named person or party: pro, anti and neutral counts,',
      'a net stance and a polarization reading.',
      'Use for "how do people feel about X", "is X popular", "who is divisive".',
      'Stance is not the same as sentiment — an angry post can still be supportive.',
      'High polarization with a middling net means divisive (two strong camps); a low net',
      'with low polarization means broadly disliked. Say which one it is.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: 'Person, party or organisation name.' },
      },
      required: ['who'],
      additionalProperties: false,
    },
  },
  async execute(args, ctx) {
    const who = String(args.who ?? '').trim();
    ctx.emit(`Reading stance toward ${who}`, 'get_stance');
    if (!who) return { found: false, message: 'No name given.' };

    const result = await ctx.social.stanceFor(who);
    if (!result.configured) {
      return { available: false, reason: 'Social listening is not connected.' };
    }
    if ('ambiguous' in result && result.ambiguous) {
      // Options rather than a guess, the same rule the contact lookup follows.
      return {
        found: false,
        ambiguous: result.ambiguous,
        message: `"${who}" matches more than one tracked entity. Ask which is meant.`,
      };
    }
    if (!('found' in result) || !result.found) {
      return { found: false, message: `Nobody matching "${who}" is tracked.` };
    }
    return result;
  },
};

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [
  raceSummary,
  incidentHotspots,
  irevAttention,
  runSql,
  evidencePhotos,
  makeChart,
  triageSnapshot,
  scopeContacts,
  socialMood,
  narrativesTool,
  socialAlerts,
  stanceTool,
];

export const ASSISTANT_TOOL_DEFINITIONS: LlmToolDefinition[] =
  ASSISTANT_TOOLS.map((tool) => tool.definition);

export function findAssistantTool(name: string): AssistantTool | undefined {
  return ASSISTANT_TOOLS.find((tool) => tool.definition.name === name);
}
