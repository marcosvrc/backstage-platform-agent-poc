// @ts-check

/**
 * Tabelas de governança do Platform Agent: pedidos, ações executadas e rodadas de evals.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('agent_requests', table => {
    table.string('id').primary().comment('ID do pedido (UUID)');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.string('user_ref').notNullable().index();
    table.text('teams').notNullable().comment('JSON: lista de Groups do usuário');
    table.string('kind').notNullable().comment('message | resume (após aprovação)');
    table.string('model').notNullable();
    table.string('gateway').notNullable();
    table
      .string('status')
      .notNullable()
      .comment('ok | awaiting_approval | refused | max_iterations | error | aborted');
    table.text('error').nullable();
    table.integer('latency_ms').notNullable();
    table.integer('model_calls').notNullable();
    table.integer('input_tokens').notNullable();
    table.integer('output_tokens').notNullable();
    table.integer('cache_read_tokens').notNullable();
    table.integer('cache_write_tokens').notNullable();
    table.text('prompt_preview').nullable().comment('Só com agent.governance.storePrompts');
  });

  await knex.schema.createTable('agent_tool_calls', table => {
    table.increments('id');
    table
      .string('request_id')
      .notNullable()
      .references('id')
      .inTable('agent_requests')
      .onDelete('CASCADE');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.string('tool_use_id').notNullable();
    table.string('action_id').notNullable().index();
    table.boolean('read_only').notNullable();
    table.string('approval').notNullable().comment('auto | approved | rejected | pending');
    table.string('status').notNullable().comment('ok | error | not_executed');
    table.text('error').nullable();
    table.integer('latency_ms').nullable();
  });

  await knex.schema.createTable('agent_eval_runs', table => {
    table.increments('id');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now()).index();
    table.string('user_ref').notNullable();
    table.string('model').notNullable();
    table.string('gateway').notNullable();
    table.integer('total').notNullable();
    table.integer('passed').notNullable();
    table.integer('invalid').notNullable().comment('Execuções com erro de infraestrutura');
    table.text('by_hypothesis').notNullable().comment('JSON');
    table.text('usage').notNullable().comment('JSON');
    table.integer('latency_p50_ms').nullable();
    table.integer('latency_p90_ms').nullable();
  });
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTable('agent_tool_calls');
  await knex.schema.dropTable('agent_requests');
  await knex.schema.dropTable('agent_eval_runs');
};
