// @ts-check

/**
 * Alertas de orçamento já enviados (um por time, período e limiar),
 * para não repetir a notificação a cada verificação.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('agent_budget_alerts', table => {
    table.increments('id');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.string('team_ref').notNullable();
    /** Fim do período de orçamento (budget_reset_at do gateway). */
    table.string('period').notNullable();
    /** Fração do orçamento, ex.: 0.8 ou 1 */
    table.float('threshold').notNullable();
    table.float('spend_usd').notNullable();
    table.float('max_budget_usd').notNullable();
    table.unique(['team_ref', 'period', 'threshold']);
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTable('agent_budget_alerts');
};
