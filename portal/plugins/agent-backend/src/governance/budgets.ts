import type { AuthService, LoggerService } from '@backstage/backend-plugin-api';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { NotificationService } from '@backstage/plugin-notifications-node';
import type { GatewayBudgets, TeamBudgetStatus } from '../gateway';
import type { GovernanceStore } from './store';

export interface BudgetSettings {
  /** Liga o orçamento por time (só tem efeito se o gateway suportar). */
  enabled: boolean;
  /** Orçamento mensal padrão por time, em USD. */
  monthlyUsd: number;
  /** Exceções por time, chave = nome do Group (ex.: platform-team) ou entity ref. */
  teams: Record<string, number>;
  /** Frações do orçamento que disparam alerta, ex.: [0.8, 1]. */
  thresholds: number[];
  /** Quem recebe todos os alertas (além do próprio time). */
  notify: string[];
}

export interface BudgetCheck {
  blocked: boolean;
  status?: TeamBudgetStatus;
}

/** Quanto tempo a leitura de gasto do gateway é reaproveitada. */
const STATUS_TTL_MS = 60_000;

/**
 * Orçamento de IA por time.
 *
 * - Sincroniza os Groups do catálogo com o gateway (cada time com seu orçamento mensal).
 * - Antes de cada pedido, garante o time no gateway e recusa cedo se o orçamento acabou.
 * - Periodicamente, envia alertas (sino do Backstage) ao atingir os limiares.
 *
 * A aplicação do limite é do gateway (o LiteLLM bloqueia a chamada); este serviço
 * só prepara, informa e avisa. Gateways sem orçamento deixam tudo desligado.
 */
export class BudgetService {
  readonly #ensured = new Map<string, Promise<void>>();
  #cache?: { at: number; items: Promise<TeamBudgetStatus[]> };

  constructor(
    private readonly deps: {
      budgets?: GatewayBudgets;
      settings: BudgetSettings;
      store: GovernanceStore;
      catalog: CatalogService;
      auth: AuthService;
      notifications: NotificationService;
      logger: LoggerService;
    },
  ) {}

  get active(): boolean {
    return Boolean(this.deps.budgets && this.deps.settings.enabled);
  }

  budgetFor(teamRef: string): number {
    const { teams, monthlyUsd } = this.deps.settings;
    const name = parseEntityRef(teamRef, { defaultKind: 'group' }).name;
    return teams[teamRef] ?? teams[name] ?? monthlyUsd;
  }

  /** Garante o time no gateway e diz se o orçamento já acabou. */
  async prepare(teamRef: string): Promise<BudgetCheck> {
    if (!this.active) return { blocked: false };
    await this.#ensure(teamRef);
    const status = (await this.#statuses()).find(s => s.teamRef === teamRef);
    const blocked =
      status?.maxBudgetUsd !== undefined && status.spendUsd >= status.maxBudgetUsd;
    return { blocked, status };
  }

  /** Avisa que o gateway bloqueou: a próxima leitura busca o gasto atualizado. */
  invalidate() {
    this.#cache = undefined;
  }

  /** Tarefa periódica: sincroniza os times do catálogo e envia os alertas. */
  async sync(): Promise<void> {
    if (!this.active) return;
    const { items } = await this.deps.catalog.getEntities(
      { filter: { kind: 'Group' }, fields: ['kind', 'metadata.name', 'metadata.namespace'] },
      { credentials: await this.deps.auth.getOwnServiceCredentials() },
    );
    for (const group of items) {
      const teamRef = stringifyEntityRef(group);
      this.#ensured.delete(teamRef); // reaplica o orçamento (pode ter mudado na config)
      await this.#ensure(teamRef).catch(err =>
        this.deps.logger.warn(`Orçamento: falha ao sincronizar ${teamRef}: ${err}`),
      );
    }
    this.invalidate();
    await this.checkAlerts(await this.#statuses());
  }

  /** Envia um alerta por time e limiar atingido (uma vez por período). */
  async checkAlerts(statuses: TeamBudgetStatus[]): Promise<void> {
    const thresholds = [...this.deps.settings.thresholds].sort((a, b) => b - a);
    for (const s of statuses) {
      if (!s.maxBudgetUsd || s.maxBudgetUsd <= 0) continue;
      const ratio = s.spendUsd / s.maxBudgetUsd;
      const threshold = thresholds.find(t => ratio >= t);
      if (threshold === undefined) continue;
      const period = s.resetAt ?? new Date().toISOString().slice(0, 7);
      const isNew = await this.deps.store.recordBudgetAlert({
        teamRef: s.teamRef,
        period,
        threshold,
        spendUsd: s.spendUsd,
        maxBudgetUsd: s.maxBudgetUsd,
      });
      if (isNew) await this.#notify(s, ratio, threshold, period);
    }
  }

  /** Configuração (sem consultar o gateway). */
  describe() {
    return {
      supported: Boolean(this.deps.budgets),
      /** managed: o portal define o orçamento; external: definido no gateway. */
      mode: this.deps.budgets?.mode,
      enabled: this.deps.settings.enabled,
      monthlyUsd: this.deps.settings.monthlyUsd,
      overrides: this.deps.settings.teams,
      thresholds: this.deps.settings.thresholds,
      notify: this.deps.settings.notify,
    };
  }

  /** Dados para o painel de governança. */
  async report() {
    const base = this.describe();
    if (!this.active) return { ...base, teams: [], alerts: [] };
    const [statuses, alerts] = await Promise.all([
      this.#statuses(),
      this.deps.store.budgetAlerts(20),
    ]);
    return {
      ...base,
      teams: statuses
        .map(s => ({
          ...s,
          ratio: s.maxBudgetUsd ? s.spendUsd / s.maxBudgetUsd : undefined,
        }))
        .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || b.spendUsd - a.spendUsd),
      alerts,
    };
  }

  #ensure(teamRef: string): Promise<void> {
    let pending = this.#ensured.get(teamRef);
    if (!pending) {
      pending = this.deps.budgets!.ensureTeam(teamRef, this.budgetFor(teamRef));
      pending.catch(() => this.#ensured.delete(teamRef));
      this.#ensured.set(teamRef, pending);
      this.invalidate();
    }
    return pending;
  }

  #statuses(): Promise<TeamBudgetStatus[]> {
    if (!this.#cache || Date.now() - this.#cache.at > STATUS_TTL_MS) {
      const items = this.deps.budgets!.list();
      items.catch(() => {
        this.#cache = undefined;
      });
      this.#cache = { at: Date.now(), items };
    }
    return this.#cache.items;
  }

  async #notify(s: TeamBudgetStatus, ratio: number, threshold: number, period: string) {
    const team = parseEntityRef(s.teamRef, { defaultKind: 'group' }).name;
    const spend = `US$ ${s.spendUsd.toFixed(2)}`;
    const max = `US$ ${s.maxBudgetUsd!.toFixed(2)}`;
    const reset = s.resetAt
      ? new Date(s.resetAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
      : 'o próximo mês';
    const exhausted = threshold >= 1;
    const payload = {
      title: exhausted
        ? `Orçamento de IA esgotado: ${team}`
        : `Orçamento de IA: ${team} usou ${Math.round(ratio * 100)}%`,
      description: exhausted
        ? `O time ${team} atingiu o orçamento mensal do Platform Agent (${spend} de ${max}). O agente fica bloqueado para o time até ${reset}. Para liberar antes, peça ao time de plataforma para aumentar o orçamento.`
        : `O time ${team} já gastou ${spend} de ${max} do orçamento mensal do Platform Agent. Ao chegar a 100%, o agente fica bloqueado para o time até ${reset}.`,
      severity: exhausted ? ('critical' as const) : ('high' as const),
      topic: 'Orçamento de IA',
      // Mesmo escopo no período: o alerta de 100% substitui o de 80% no sino.
      scope: `agent-budget:${s.teamRef}:${period}`,
    };
    const admins = this.deps.settings.notify;
    try {
      if (!admins.includes(s.teamRef)) {
        await this.deps.notifications.send({
          recipients: { type: 'entity', entityRef: s.teamRef },
          payload,
        });
      }
      if (admins.length > 0) {
        await this.deps.notifications.send({
          recipients: { type: 'entity', entityRef: admins },
          payload: { ...payload, link: '/governanca-ia' },
        });
      }
      this.deps.logger.info(
        `Orçamento: alerta de ${Math.round(threshold * 100)}% enviado para ${s.teamRef}`,
      );
    } catch (err) {
      this.deps.logger.error(`Orçamento: falha ao notificar ${s.teamRef}`, err as Error);
    }
  }
}
