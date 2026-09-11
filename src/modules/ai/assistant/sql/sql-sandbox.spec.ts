import { MAX_ROWS } from './allowlist';
import {
  SqlValidationError,
  enforceLimit,
  parseSingleSelect,
  sanitizeSql,
} from './sql-sandbox';

/**
 * The sandbox is the only thing standing between model-authored SQL and the
 * database, so these cases are written as an attacker would: every rejection
 * below is a way in if it regresses.
 */
describe('sanitizeSql', () => {
  const expectRejected = (sql: string) => {
    expect(() => sanitizeSql(sql)).toThrow(SqlValidationError);
  };

  describe('allows legitimate analytical queries', () => {
    it.each([
      ['plain select', 'SELECT id, name FROM lgas'],
      ['contests', 'SELECT id, type, slug, label FROM contests'],
      [
        'assembly seats',
        'SELECT id, name, code FROM state_assembly_constituencies',
      ],
      [
        'results by contest',
        'SELECT cr."contestId", cr."votesCast" FROM collation_results cr',
      ],
      ['count(*)', 'SELECT count(*) FROM field_reports'],
      [
        'aliased join',
        'SELECT l.name, cr."votesCast" FROM collation_results cr JOIN lgas l ON l.id = cr."scopeId"',
      ],
      [
        'group by',
        'SELECT "incidentSeverity", count(*) FROM field_reports GROUP BY "incidentSeverity"',
      ],
      ['cte', 'WITH x AS (SELECT id, name FROM lgas) SELECT id, name FROM x'],
      ['derived table', 'SELECT t.name FROM (SELECT name FROM lgas) t'],
      [
        'semicolon inside a string literal',
        "SELECT id FROM lgas WHERE name = 'a;b'",
      ],
    ])('%s', (_label, sql) => {
      expect(() => sanitizeSql(sql)).not.toThrow();
    });

    it('allows the jsonb party-votes access pattern', () => {
      const sql = `SELECT ("partyResults"->>'APC')::int AS apc FROM collation_results`;
      expect(sanitizeSql(sql)).toContain('->>');
    });

    it('allows turnout arithmetic with a divide-by-zero guard', () => {
      const sql =
        'SELECT round(100.0 * "accreditedVoters" / nullif("registeredVoters",0), 1) FROM collation_results';
      expect(() => sanitizeSql(sql)).not.toThrow();
    });
  });

  describe('rejects writes however they are nested', () => {
    it.each([
      ['statement stacking', 'SELECT id FROM lgas; DROP TABLE users'],
      ['bare update', 'UPDATE campaigns SET name = 1'],
      [
        'insert inside a CTE',
        'WITH x AS (INSERT INTO commitments (id) VALUES (1) RETURNING id) SELECT id FROM x',
      ],
      [
        'insert in a later CTE',
        'WITH a AS (SELECT id FROM lgas), b AS (INSERT INTO lgas (id) VALUES (1) RETURNING id) SELECT id FROM a',
      ],
      ['select into', 'SELECT id INTO evil FROM lgas'],
    ])('%s', (_label, sql) => expectRejected(sql));
  });

  describe('rejects reads outside the allowlist', () => {
    it.each([
      ['users table', 'SELECT id FROM users'],
      ['users via alias', 'SELECT u.id FROM users u'],
      [
        'users via join',
        'SELECT l.name FROM lgas l JOIN users u ON u.id = l.id',
      ],
      ['users via union', 'SELECT id FROM lgas UNION SELECT id FROM users'],
      [
        'users hidden in a CTE',
        'WITH x AS (SELECT id FROM users) SELECT id FROM x',
      ],
      [
        'situation_updates (no campaign scoping)',
        'SELECT id FROM situation_updates',
      ],
    ])('%s', (_label, sql) => expectRejected(sql));

    it.each([
      ['leaderPhone', 'SELECT "leaderPhone" FROM support_groups'],
      [
        'leaderPhone via alias',
        'SELECT sg."leaderPhone" FROM support_groups sg',
      ],
      ['volunteer phoneNumber', 'SELECT "phoneNumber" FROM volunteers'],
      ['reporter identity', 'SELECT "reportedById" FROM field_reports'],
      [
        'internal ocr verdict',
        'SELECT "ocrVerification" FROM collation_results',
      ],
      ['unknown column', 'SELECT nope FROM lgas'],
    ])('withheld column: %s', (_label, sql) => expectRejected(sql));
  });

  describe('rejects dangerous syntax', () => {
    it.each([
      ['bare wildcard', 'SELECT * FROM lgas'],
      ['aliased wildcard', 'SELECT l.* FROM lgas l'],
      ['unlisted function', 'SELECT pg_sleep(10) FROM lgas'],
      [
        'unlisted cast target',
        'SELECT CAST("votesCast" AS money) FROM collation_results',
      ],
    ])('%s', (_label, sql) => expectRejected(sql));
  });

  describe('row cap', () => {
    it('adds a limit when none is given', () => {
      expect(sanitizeSql('SELECT id FROM lgas')).toMatch(/LIMIT 200$/);
    });

    it('lowers a limit above the cap', () => {
      expect(sanitizeSql('SELECT id FROM lgas LIMIT 500')).toMatch(
        /LIMIT 200$/,
      );
    });

    it('leaves a limit below the cap alone', () => {
      expect(sanitizeSql('SELECT id FROM lgas LIMIT 50')).toMatch(/LIMIT 50$/);
    });

    it('preserves OFFSET while capping the row count', () => {
      // Regression: with OFFSET the parser puts the count first, so indexing
      // the last value capped the offset and let the real limit through.
      const sql = sanitizeSql('SELECT id FROM lgas LIMIT 900 OFFSET 20');
      expect(sql).toContain('LIMIT 200');
      expect(sql).toContain('OFFSET 20');
    });

    it('caps the count and not the offset in the AST', () => {
      const ast = enforceLimit(
        parseSingleSelect('SELECT id FROM lgas LIMIT 900 OFFSET 20'),
      );
      const limit = ast.limit as { value: Array<{ value: number }> };
      expect(limit.value[0].value).toBe(MAX_ROWS);
      expect(limit.value[1].value).toBe(20);
    });
  });

  describe('output contract', () => {
    it('returns regenerated SQL, not the input', () => {
      const out = sanitizeSql('select id from lgas');
      expect(out).not.toBe('select id from lgas');
      expect(out.startsWith('SELECT')).toBe(true);
    });

    it('keeps camelCase identifiers quoted through serialisation', () => {
      // Columns are camelCase in Postgres; unquoted they would be folded to
      // lowercase and every query would fail.
      const out = sanitizeSql(
        'SELECT "campaignId", "partyResults" FROM collation_results',
      );
      expect(out).toContain('"campaignId"');
      expect(out).toContain('"partyResults"');
    });

    it('never emits a second statement', () => {
      const out = sanitizeSql("SELECT id FROM lgas WHERE name = 'a;b'");
      expect(out.replace(/'[^']*'/g, "''")).not.toContain(';');
    });
  });
});
