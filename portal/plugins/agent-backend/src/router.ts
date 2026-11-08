import Anthropic from '@anthropic-ai/sdk';
import type {
  AuditorService,
  BackstageCredentials,
  BackstageUserPrincipal,
  HttpAuthService,
  LoggerService,
  PermissionsService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import type { ActionsService } from '@backstage/backend-plugin-api/alpha';
import { InputError, NotAllowedError } from '@backstage/errors';
import { AuthorizeResult, BasicPermission } from '@backstage/plugin-permission-common';
import express from 'express';
import Router from 'express-promise-router';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { AgentEvent, AgentSettings, RunSummary, runAgent } from './agent/runAgent';
import { requiresApproval } from './agent/tools';
import type { ModelGateway } from './gateway';
import type { GovernanceStore, RequestRecord } from './governance/store';
import { agentEvalsPublishPermission, agentGovernanceReadPermission } from './permissions';

const chatSchema = z.object({
  // O histórico vem do frontend no formato da Messages API; a própria API valida a estrutura.
  messages: z
    .array(
      z
        .object({
          role: z.enum(['user', 'assistant']),
          content: z.union([z.string().min(1), z.array(z.unknown()).min(1)]),
        })
        .passthrough(),
    )
    .min(1)
    .max(200),
  approvals: z.record(z.boolean()).optional(),
});

const evalRunSchema = z.object({
  model: z.string().optional(),
  total: z.number().int().min(0),
  passed: z.number().int().min(0),
  invalid: z.number().int().min(0).default(0),
  byHypothesis: z.record(z.object({ pass: z.number(), total: z.number() })),
  usage: z.record(z.number()).default({}),
  latencyP50Ms: z.number().optional(),
  latencyP90Ms: z.number().optional(),
  /** Data da rodada (para importar rodadas antigas). Padrão: agora. */
  createdAt: z.string().datetime().optional(),
});

export interface GovernanceSettings {
  /** Grava o início de cada pergunta na auditoria (desligado por padrão). */
  storePrompts: boolean;
  /** Preço por milhão de tokens, por modelo (USD). Opcional: sem ele, o painel mostra só tokens. */
  pricing: Record<
    string,
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  >;
}

export async function createRouter(opts: {
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  permissions: PermissionsService;
  auditor: AuditorService;
  actionsService: ActionsService;
  logger: LoggerService;
  settings: AgentSettings;
  gateway: ModelGateway;
  store: GovernanceStore;
  governance: GovernanceSettings;
}): Promise<express.Router> {
  const { httpAuth, userInfo, permissions, auditor, actionsService, logger, settings, gateway, store } =
    opts;

  const authorize = async (
    credentials: BackstageCredentials<BackstageUserPrincipal>,
    permission: BasicPermission,
  ) => {
    const [decision] = await permissions.authorize([{ permission }], { credentials });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError('Acesso restrito ao time de plataforma');
    }
  };

  const router = Router();
  router.use(express.json({ limit: '5mb' }));

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', model: settings.model, gateway: gateway.type });
  });

  router.post('/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InputError(parsed.error.toString());
    }
    // Somente usuários: o agente age em nome de quem está logado no portal.
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const teams = ownershipEntityRefs.filter(r => r.startsWith('group:'));
    const userRef = credentials.principal.userEntityRef;
    const requestId = randomUUID();
    const startedAt = Date.now();
    const kind = parsed.data.approvals ? 'resume' : 'message';

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const emit = (event: AgentEvent) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };

    const summary: RunSummary = {
      status: 'ok',
      usage: {
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      toolCalls: [],
    };
    let status: RequestRecord['status'] = 'ok';
    let errorMessage: string | undefined;
    try {
      await runAgent({
        client: gateway.client(),
        requestExtras: gateway.requestExtras({ userRef, teams, requestId }),
        actionsService,
        credentials,
        logger,
        settings,
        messages: parsed.data.messages as Anthropic.Beta.BetaMessageParam[],
        approvals: parsed.data.approvals,
        emit,
        signal: abort.signal,
        summary,
      });
      status = summary.status;
    } catch (err) {
      if (abort.signal.aborted) {
        status = 'aborted';
      } else {
        status = 'error';
        errorMessage = describeError(err);
        logger.error('Falha no agente', err as Error);
        emit({ type: 'error', message: errorMessage });
      }
    } finally {
      res.end();
    }

    // Governança: grava o pedido e audita as ações de escrita. Falhas aqui não afetam o usuário.
    try {
      const lastUser = [...parsed.data.messages].reverse().find(m => m.role === 'user');
      await store.recordRequest({
        id: requestId,
        userRef,
        teams,
        kind,
        model: settings.model,
        gateway: gateway.type,
        status,
        error: errorMessage,
        latencyMs: Date.now() - startedAt,
        usage: summary.usage,
        toolCalls: summary.toolCalls,
        promptPreview:
          opts.governance.storePrompts && kind === 'message' && typeof lastUser?.content === 'string'
            ? lastUser.content.slice(0, 300)
            : undefined,
      });
      for (const call of summary.toolCalls.filter(t => !t.readOnly && t.approval !== 'pending')) {
        const event = await auditor.createEvent({
          eventId: 'agent-write-action',
          severityLevel: call.approval === 'approved' ? 'medium' : 'low',
          request: req,
          meta: { requestId, actionId: call.actionId, approval: call.approval, status: call.status },
        });
        if (call.status === 'error') {
          await event.fail({ error: new Error(call.error ?? 'falha na ação') });
        } else {
          await event.success();
        }
      }
    } catch (err) {
      logger.error('Falha ao gravar a governança do pedido', err as Error);
    }
  });

  // ---------- Governança (restrito pela permissão agent.governance.read) ----------

  router.get('/governance/overview', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorize(credentials, agentGovernanceReadPermission);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.json(await store.overview(days));
  });

  router.get('/governance/audit', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorize(credentials, agentGovernanceReadPermission);
    res.json({
      items: await store.audit({
        limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 500),
        userRef: typeof req.query.user === 'string' ? req.query.user : undefined,
        onlyWrites: req.query.writes === 'true',
      }),
    });
  });

  router.get('/governance/policy', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorize(credentials, agentGovernanceReadPermission);
    const { actions } = await actionsService.list({ credentials });
    res.json({
      model: { id: settings.model, effort: settings.effort, maxIterations: settings.maxIterations },
      gateway: { ...gateway.describe(), health: await gateway.health() },
      storePrompts: opts.governance.storePrompts,
      pricing: opts.governance.pricing,
      actions: actions
        .map(a => ({
          id: a.id,
          title: a.title,
          pluginId: a.pluginId,
          readOnly: Boolean(a.attributes.readOnly),
          destructive: Boolean(a.attributes.destructive),
          requiresApproval: requiresApproval(a),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  });

  router.get('/governance/evals', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorize(credentials, agentGovernanceReadPermission);
    res.json({ items: await store.evalRuns(Math.min(Number(req.query.limit) || 20, 200)) });
  });

  router.post('/governance/evals', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    await authorize(credentials, agentEvalsPublishPermission);
    const parsed = evalRunSchema.safeParse(req.body);
    if (!parsed.success) throw new InputError(parsed.error.toString());
    await store.recordEvalRun({
      ...parsed.data,
      model: parsed.data.model ?? settings.model,
      gateway: gateway.type,
      userRef: credentials.principal.userEntityRef,
    });
    res.status(201).json({ ok: true });
  });

  return router;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Credencial do modelo inválida ou ausente. Verifique ANTHROPIC_API_KEY ou a chave do gateway (agent.gateway.apiKey).';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Limite de requisições atingido. Tente novamente em instantes.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Erro da API (${err.status}): ${err.message}`;
  }
  if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message)) {
    return 'Chave da API da Anthropic ausente. Defina ANTHROPIC_API_KEY antes de iniciar o portal.';
  }
  return err instanceof Error ? err.message : String(err);
}
