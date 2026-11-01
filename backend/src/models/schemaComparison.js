/**
 * Model statics from a map, ignoring non-model values such as the Sequelize
 * instance that some callers pass alongside the models.
 */
function modelList(models) {
  return Object.values(models).filter((model) => typeof model?.getTableName === 'function');
}

/**
 * Table names the models map to. Derived from the models themselves so the
 * verification queries cannot drift behind a newly registered model.
 *
 * @param {Record<string, import('sequelize').ModelStatic<any>>} models
 * @returns {string[]} sorted, de-duplicated table names
 */
export function modelTableNames(models) {
  return [...new Set(modelList(models).map((model) => model.getTableName()))].sort();
}

/** SQL placeholders ($1), ($1, $2), ... for an IN list. */
const placeholders = (values) => values.map((_, index) => `$${index + 1}`).join(', ');

/**
 * Maps Sequelize types onto the data_type spelling used by information_schema.
 * Unmapped types return null and are skipped, so an exotic column cannot
 * produce a false failure.
 */
const DATA_TYPE_ALIASES = Object.freeze({
  varchar: 'character varying',
  char: 'character',
  bpchar: 'character',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  bool: 'boolean',
  int4: 'integer',
  int8: 'bigint',
  float8: 'double precision',
});

/** @param {import('sequelize').AbstractDataType} type */
export function expectedDataType(type) {
  if (typeof type?.toSql !== 'function') return null;
  let sql;
  try {
    sql = type.toSql();
  } catch {
    return null;
  }
  if (typeof sql !== 'string') return null;
  const base = sql
    .replace(/\(.*\)/, '')
    .trim()
    .toLowerCase();
  if (!base) return null;
  return DATA_TYPE_ALIASES[base] ?? base;
}

/**
 * Lists the columns of the given tables. Works on any PostgreSQL (Supabase,
 * local, PGlite) via information_schema.
 *
 * @param {string[]} tables
 */
export function buildColumnsQuery(tables) {
  return {
    sql: `
      SELECT table_name, column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN (${placeholders(tables)})
      ORDER BY table_name, ordinal_position
    `,
    bind: [...tables],
  };
}

/**
 * Lists relrowsecurity for the given tables. A table absent from the result
 * was not created; compareModelsToColumns already reports that.
 *
 * @param {string[]} tables
 */
export function buildRlsQuery(tables) {
  return {
    sql: `
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN (${placeholders(tables)})
      ORDER BY relname
    `,
    bind: [...tables],
  };
}

/**
 * Compares Sequelize model definitions with the live table columns and returns
 * a list of human-readable mismatches (empty when they agree).
 *
 * @param {Record<string, import('sequelize').ModelStatic<any>>} models
 * @param {{ table_name: string, column_name: string, is_nullable: string }[]} columnRows
 */
export function compareModelsToColumns(models, columnRows) {
  const problems = [];

  for (const model of modelList(models)) {
    const table = model.getTableName();
    const columns = new Map(
      columnRows.filter((row) => row.table_name === table).map((row) => [row.column_name, row]),
    );

    if (columns.size === 0) {
      problems.push(`table "${table}" does not exist (run npm run db:migrate)`);
      continue;
    }

    const mappedFields = new Set();
    for (const [attribute, definition] of Object.entries(model.getAttributes())) {
      const field = definition.field ?? attribute;
      mappedFields.add(field);
      const column = columns.get(field);
      if (!column) {
        problems.push(`${table}: model attribute "${attribute}" maps to missing column "${field}"`);
        continue;
      }
      const columnRequired = column.is_nullable === 'NO';
      const expectedType = expectedDataType(definition.type);
      if (expectedType && column.data_type && column.data_type !== expectedType) {
        problems.push(
          `${table}.${field}: column type is "${column.data_type}" but the model expects "${expectedType}"`,
        );
      }
      const modelRequired = definition.allowNull === false || definition.primaryKey === true;
      if (columnRequired !== modelRequired) {
        problems.push(
          `${table}.${field}: column is ${columnRequired ? 'NOT NULL' : 'nullable'} but model "${attribute}" is ${modelRequired ? 'required' : 'optional'}`,
        );
      }
    }

    for (const field of columns.keys()) {
      if (!mappedFields.has(field)) {
        problems.push(`${table}: column "${field}" is not mapped by model ${model.name}`);
      }
    }
  }

  return problems;
}
