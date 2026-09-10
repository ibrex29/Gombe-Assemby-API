import { Parser } from 'node-sql-parser';
import {
  ALLOWED_BINARY_OPERATORS,
  ALLOWED_CAST_TYPES,
  ALLOWED_COLUMNS,
  ALLOWED_FUNCTIONS,
  ALLOWED_TABLES,
  MAX_ROWS,
} from './allowlist';

/**
 * Validates and rewrites model-authored SQL before it reaches the database.
 *
 * Two properties are load-bearing:
 *
 *  1. Fail closed. Anything the parser cannot produce a recognised shape for is
 *     rejected rather than passed through. Every check below walks the whole AST
 *     generically instead of enumerating the shapes we expect, so a hostile query
 *     cannot hide a write inside a nesting level we forgot about.
 *  2. Only regenerated SQL runs. The validated AST is re-serialised and it is
 *     that text which executes, never the model's original string.
 *
 * Every step is exported so the rules can be unit-tested without a database.
 */

const PARSER_OPTS = { database: 'Postgresql' } as const;

/** Rejected query. The message goes back to the model so it can rewrite. */
export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

/** AST node types that mutate. Rejected at any depth. */
const WRITE_NODE_TYPES = new Set([
  'insert',
  'update',
  'delete',
  'replace',
  'create',
  'drop',
  'alter',
  'truncate',
  'rename',
  'grant',
  'revoke',
  'call',
  'execute',
  'set',
  'declare',
  'lock',
  'unlock',
  'analyze',
  'attach',
  'transaction',
  'proc',
]);

type AstNode = Record<string, unknown>;

function isObject(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null;
}

/**
 * Visits every object in the AST, including arrays, CTEs, UNION arms (`_next`),
 * and every level of subquery. Shape-agnostic on purpose.
 */
function walk(
  node: unknown,
  visit: (node: AstNode) => void,
  seen = new Set<unknown>(),
) {
  if (!isObject(node)) return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, seen);
    return;
  }

  visit(node);
  for (const value of Object.values(node)) {
    if (isObject(value)) walk(value, visit, seen);
  }
}

/** Blanks out string and dollar-quoted literals so we can scan for stray statements. */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\$\$[\s\S]*?\$\$/g, '');
}

export function parseSingleSelect(sql: string): AstNode {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new SqlValidationError('Empty query.');
  }

  // Catch statement stacking before the parser has a chance to be lenient.
  const withoutStrings = stripStringLiterals(trimmed).replace(/;\s*$/, '');
  if (withoutStrings.includes(';')) {
    throw new SqlValidationError(
      'Only one statement is allowed. Remove the extra ";".',
    );
  }

  let ast: unknown;
  try {
    ast = new Parser().astify(trimmed, PARSER_OPTS);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unparseable';
    throw new SqlValidationError(`Could not parse SQL: ${detail}`);
  }

  if (Array.isArray(ast)) {
    if (ast.length !== 1) {
      throw new SqlValidationError('Only one statement is allowed.');
    }
    ast = ast[0];
  }

  if (!isObject(ast) || ast.type !== 'select') {
    throw new SqlValidationError('Only SELECT statements are allowed.');
  }

  return ast;
}

export function assertNoEmbeddedWrites(ast: AstNode) {
  walk(ast, (node) => {
    const type = node.type;
    if (typeof type === 'string' && WRITE_NODE_TYPES.has(type.toLowerCase())) {
      throw new SqlValidationError(
        `Only read-only SELECT queries are allowed (found "${type}").`,
      );
    }
  });
}

export function assertNoIntoOrLocking(ast: AstNode) {
  walk(ast, (node) => {
    // SELECT ... INTO creates a table; node-sql-parser keeps it on `into`.
    const into = node.into;
    if (isObject(into) && into.position != null) {
      throw new SqlValidationError('SELECT ... INTO is not allowed.');
    }
    if (node.locking_read != null || node.for_update != null) {
      throw new SqlValidationError('Row locking clauses are not allowed.');
    }
  });
}

export function assertNoWildcard(ast: AstNode) {
  walk(ast, (node) => {
    if (!Array.isArray(node.columns)) return;
    for (const column of node.columns as unknown[]) {
      // Bare `SELECT *` parses as the string '*' in the columns array.
      if (column === '*') {
        throw new SqlValidationError(
          'SELECT * is not allowed. Name the columns you need.',
        );
      }
      if (!isObject(column)) continue;
      const expr = column.expr;
      if (!isObject(expr)) continue;
      // `alias.*` parses as a column_ref whose column is '*'.
      if (
        expr.type === 'column_ref' &&
        (expr.column === '*' || expr.column === null)
      ) {
        throw new SqlValidationError(
          'SELECT * is not allowed. Name the columns you need.',
        );
      }
    }
  });
}

function functionName(node: AstNode): string | null {
  const name = node.name;
  if (typeof name === 'string') return name;
  if (isObject(name)) {
    const parts: unknown = name.name;
    if (Array.isArray(parts)) {
      const last: unknown = (parts as unknown[])[parts.length - 1];
      if (isObject(last) && typeof last.value === 'string') return last.value;
      if (typeof last === 'string') return last;
    }
  }
  return null;
}

export function assertFunctionsAllowed(ast: AstNode) {
  walk(ast, (node) => {
    if (node.type !== 'function' && node.type !== 'aggr_func') return;
    const name = functionName(node);
    if (!name) {
      // Unrecognised shape — refuse rather than assume it is harmless.
      throw new SqlValidationError('Unsupported function call.');
    }
    if (!ALLOWED_FUNCTIONS.has(name.toUpperCase())) {
      throw new SqlValidationError(`Function "${name}" is not allowed.`);
    }
  });
}

export function assertCastsAllowed(ast: AstNode) {
  walk(ast, (node) => {
    if (node.type !== 'cast') return;
    const target = node.target;
    const entries = Array.isArray(target) ? target : [target];
    for (const entry of entries) {
      if (!isObject(entry)) {
        throw new SqlValidationError('Unsupported cast.');
      }
      const dataType = entry.dataType;
      if (
        typeof dataType !== 'string' ||
        !ALLOWED_CAST_TYPES.has(dataType.toUpperCase())
      ) {
        throw new SqlValidationError(
          `Cast to "${String(dataType)}" is not allowed.`,
        );
      }
    }
  });
}

export function assertOperatorsAllowed(ast: AstNode) {
  walk(ast, (node) => {
    if (node.type !== 'binary_expr' && node.type !== 'unary_expr') return;
    const operator = node.operator;
    if (typeof operator !== 'string') {
      throw new SqlValidationError('Unsupported operator.');
    }
    if (!ALLOWED_BINARY_OPERATORS.has(operator.toUpperCase())) {
      throw new SqlValidationError(`Operator "${operator}" is not allowed.`);
    }
  });
}

export function collectTables(ast: AstNode): string[] {
  const tables = new Set<string>();
  const cteNames = new Set<string>();

  walk(ast, (node) => {
    // CTE names are not real tables; record them so they are not rejected.
    if (Array.isArray(node.with)) {
      for (const cte of node.with as unknown[]) {
        if (!isObject(cte)) continue;
        const name = cte.name;
        if (typeof name === 'string') cteNames.add(name.toLowerCase());
        else if (isObject(name) && typeof name.value === 'string') {
          cteNames.add(name.value.toLowerCase());
        }
      }
    }
    // Only FROM entries name real tables. Reading `table` off any node would
    // also pick up column_ref aliases (`l` in `l.name`) and reject valid joins.
    if (Array.isArray(node.from)) {
      for (const entry of node.from as unknown[]) {
        if (isObject(entry) && typeof entry.table === 'string') {
          tables.add(entry.table);
        }
      }
    }
  });

  return [...tables].filter((table) => !cteNames.has(table.toLowerCase()));
}

export function assertTablesAllowed(tables: string[]) {
  for (const table of tables) {
    if (!ALLOWED_TABLES.includes(table)) {
      throw new SqlValidationError(
        `Table "${table}" is not available. Available tables: ${ALLOWED_TABLES.join(', ')}.`,
      );
    }
  }
}

/**
 * Maps FROM aliases to real table names so qualified columns can be checked.
 *
 * Also collects "derived" names — CTEs and subquery-in-FROM aliases. Those do
 * not correspond to a real table, and the columns they expose were already
 * validated when the walk visited the inner SELECT, so qualified references to
 * them are skipped rather than rejected. A reference to something the inner
 * query never projected fails in Postgres as an unknown column, which is a
 * query error rather than a data leak.
 */
function buildAliasMap(ast: AstNode): {
  aliases: Map<string, string>;
  derived: Set<string>;
} {
  const aliases = new Map<string, string>();
  const derived = new Set<string>();

  walk(ast, (node) => {
    if (Array.isArray(node.with)) {
      for (const cte of node.with as unknown[]) {
        if (!isObject(cte)) continue;
        const name = cte.name;
        if (typeof name === 'string') derived.add(name);
        else if (isObject(name) && typeof name.value === 'string')
          derived.add(name.value);
      }
    }

    if (!Array.isArray(node.from)) return;
    for (const entry of node.from as unknown[]) {
      if (!isObject(entry)) continue;
      const alias = typeof entry.as === 'string' && entry.as ? entry.as : null;
      const table = entry.table;

      if (typeof table !== 'string') {
        // Subquery in FROM: `(SELECT ...) t` has an expr, no table.
        if (alias) derived.add(alias);
        continue;
      }

      if (alias) aliases.set(alias, table);
      aliases.set(table, table);
    }
  });

  return { aliases, derived };
}

function collectColumnRefs(
  expr: AstNode,
): Array<{ table: string | null; name: string }> {
  const refs: Array<{ table: string | null; name: string }> = [];
  walk(expr, (node) => {
    if (node.type !== 'column_ref') return;
    const rawColumn = node.column;
    let name: string | null = null;
    if (typeof rawColumn === 'string') {
      name = rawColumn;
    } else if (isObject(rawColumn)) {
      const inner = rawColumn.expr;
      if (isObject(inner) && typeof inner.value === 'string')
        name = inner.value;
      else if (typeof rawColumn.value === 'string') name = rawColumn.value;
    }
    if (!name) return;
    const table = typeof node.table === 'string' ? node.table : null;
    refs.push({ table, name });
  });
  return refs;
}

/**
 * Validates the SELECT list against the column allowlist.
 *
 * Known limitation, carried over from the reference implementation: columns used
 * only in WHERE / JOIN / ORDER BY are not checked. Their values are never
 * returned, and the table grants plus RLS bound what they can reach.
 */
export function assertColumnsAllowed(ast: AstNode) {
  const { aliases, derived } = buildAliasMap(ast);

  walk(ast, (node) => {
    if (!Array.isArray(node.columns)) return;

    for (const column of node.columns as unknown[]) {
      if (!isObject(column)) continue;
      const expr = column.expr;
      if (!isObject(expr)) continue;

      for (const { table, name } of collectColumnRefs(expr)) {
        if (name === '*') continue; // handled by assertNoWildcard

        if (table) {
          // CTE / derived-table projections were validated in the inner SELECT.
          if (derived.has(table)) continue;
          const realTable = aliases.get(table) ?? table;
          const allowed = ALLOWED_COLUMNS[realTable];
          if (!allowed) {
            throw new SqlValidationError(
              `Table "${realTable}" is not available.`,
            );
          }
          if (!allowed.has(name)) {
            throw new SqlValidationError(
              `Column "${name}" is not available on ${realTable}.`,
            );
          }
          continue;
        }

        // Unqualified: must exist on at least one table used by the query.
        const candidates = [...new Set(aliases.values())];
        const pool = candidates.length ? candidates : [...ALLOWED_TABLES];
        const found = pool.some((candidate) =>
          ALLOWED_COLUMNS[candidate]?.has(name),
        );
        if (!found) {
          throw new SqlValidationError(`Column "${name}" is not available.`);
        }
      }
    }
  });
}

export function enforceLimit(ast: AstNode): AstNode {
  const capNode = { type: 'number', value: MAX_ROWS };
  const limit = ast.limit;

  if (
    !isObject(limit) ||
    !Array.isArray(limit.value) ||
    limit.value.length === 0
  ) {
    // node-sql-parser spells the key "seperator" [sic].
    ast.limit = { seperator: '', value: [capNode] };
    return ast;
  }

  const values = limit.value as AstNode[];
  const separator = typeof limit.seperator === 'string' ? limit.seperator : '';

  // `LIMIT 900 OFFSET 20` parses to seperator:'offset', value:[900, 20] — the
  // row count is always first, the offset second. Indexing the last element
  // instead would cap the offset and let the real limit through.
  const countIndex = 0;
  const count = values[countIndex];
  const current = isObject(count) ? Number(count.value) : Number.NaN;

  if (!Number.isFinite(current) || current > MAX_ROWS || current <= 0) {
    values[countIndex] = capNode;
  }

  ast.limit = { seperator: separator, value: values };
  return ast;
}

export function serialize(ast: AstNode): string {
  // The AST is walked as a plain object graph so the checks stay shape-agnostic;
  // hand it back to the parser's own node type here.
  const sql = new Parser().sqlify(
    ast as unknown as Parameters<Parser['sqlify']>[0],
    PARSER_OPTS,
  );
  // A CTE query serialises as `WITH x AS (...) SELECT ...`; its inner statements
  // have already been walked for writes by assertNoEmbeddedWrites.
  if (!/^\s*(?:WITH\b[\s\S]*?\bSELECT\b|SELECT\b)/i.test(sql)) {
    throw new SqlValidationError('Only SELECT statements are allowed.');
  }
  if (stripStringLiterals(sql).replace(/;\s*$/, '').includes(';')) {
    throw new SqlValidationError('Only one statement is allowed.');
  }
  return sql;
}

/**
 * Full pipeline. Returns the regenerated SQL that is safe to execute — callers
 * must run this return value, never the input.
 */
export function sanitizeSql(rawSql: string): string {
  const ast = parseSingleSelect(rawSql);
  assertNoEmbeddedWrites(ast);
  assertNoIntoOrLocking(ast);
  assertNoWildcard(ast);
  assertFunctionsAllowed(ast);
  assertCastsAllowed(ast);
  assertOperatorsAllowed(ast);
  assertTablesAllowed(collectTables(ast));
  assertColumnsAllowed(ast);
  return serialize(enforceLimit(ast));
}
