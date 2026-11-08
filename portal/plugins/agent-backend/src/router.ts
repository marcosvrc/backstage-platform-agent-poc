import Anthropic from '@anthropic-ai/sdk';
import type { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import type { ActionsService } from '@backstage/backend-plugin-api/alpha';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod/v3';
import { AgentEvent, AgentSettings, runAgent } from './agent/runAgent';

const chatSchema = z.object({
  // O histórico vem do frontend no formato da Messages API; a própria API valida a estrutura.
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.unknown() }).passthrough())
    .min(1)
    .max(200),
  approvals: z.record(z.boolean()).optional(),
});

export async function createRouter(opts: {
  httpAuth: HttpAuthService;
  actionsService: ActionsService;
  logger: LoggerService;
  settings: AgentSettings;
  anthropicApiKey?: string;
}): Promise<express.Router> {
  const { httpAuth, actionsService, logger, settings } = opts;
  let client: Anthropic | undefined;
  const getClient = () =>
    (client ??= new Anthropic(opts.anthropicApiKey ? { apiKey: opts.anthropicApiKey } : {}));

  const router = Router();
  router.use(express.json({ limit: '5mb' }));

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', model: settings.model });
  });

  router.post('/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InputError(parsed.error.toString());
    }
    // Somente usuários: o agente age em nome de quem está logado no portal.
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });

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

    try {
      await runAgent({
        client: getClient(),
        actionsService,
        credentials,
        logger,
        settings,
        messages: parsed.data.messages as Anthropic.Beta.BetaMessageParam[],
        approvals: parsed.data.approvals,
        emit,
        signal: abort.signal,
      });
    } catch (err) {
      if (!abort.signal.aborted) {
        logger.error('Falha no agente', err as Error);
        emit({ type: 'error', message: describeError(err) });
      }
    } finally {
      res.end();
    }
  });

  return router;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Chave da API da Anthropic inválida ou ausente. Defina ANTHROPIC_API_KEY antes de iniciar o portal.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Limite de requisições da API atingido. Tente novamente em instantes.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Erro da API (${err.status}): ${err.message}`;
  }
  if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message)) {
    return 'Chave da API da Anthropic ausente. Defina ANTHROPIC_API_KEY antes de iniciar o portal.';
  }
  return err instanceof Error ? err.message : String(err);
}
