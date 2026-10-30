#!/usr/bin/env node
// Connects to DATABASE_URL and verifies that the tables created by schema.sql
// match the Sequelize models and that Row Level Security is enabled.
// Read-only: makes no changes.
//
// Usage (from backend/):  npm run db:check

import { QueryTypes } from 'sequelize';
import {
  buildColumnsQuery,
  buildRlsQuery,
  compareModelsToColumns,
  modelTableNames,
} from '../src/models/schemaComparison.js';
import { withDatabase } from './lib/withDatabase.js';

await withDatabase(async ({ db, logger }) => {
  const query = (sql) => db.sequelize.query(sql, { type: QueryTypes.SELECT });
  const queryBound = ({ sql, bind }) => db.sequelize.query(sql, { type: QueryTypes.SELECT, bind });

  const [{ version }] = await query('SELECT version()');
  logger.info('Connected', { server: version.split(',')[0] });

  // Every table a model maps to, so a newly registered model cannot be missed.
  const tables = modelTableNames(db.models);

  const problems = compareModelsToColumns(db.models, await queryBound(buildColumnsQuery(tables)));

  const rls = await queryBound(buildRlsQuery(tables));
  for (const { relname, relrowsecurity } of rls) {
    if (!relrowsecurity) problems.push(`${relname}: Row Level Security is not enabled`);
  }

  if (problems.length) {
    for (const problem of problems) logger.error(problem);
    throw Object.assign(new Error(`Schema check failed with ${problems.length} problem(s)`), {
      expected: true,
    });
  }

  const [{ admins, inquiries, notes, activities }] = await query(
    `SELECT (SELECT count(*) FROM public.admins)::int AS admins,
            (SELECT count(*) FROM public.inquiries)::int AS inquiries,
            (SELECT count(*) FROM public.inquiry_notes)::int AS notes,
            (SELECT count(*) FROM public.inquiry_activities)::int AS activities`,
  );
  logger.info('Schema matches the models and RLS is enabled', {
    tables: tables.length,
    admins,
    inquiries,
    notes,
    activities,
  });
});
