import { DirectAnthropicGateway } from './DirectAnthropicGateway';

const caller = {
  userRef: 'user:default/bruno.lima',
  teams: ['group:default/checkout-team'],
  requestId: 'req-1',
};

describe('DirectAnthropicGateway', () => {
  it('direct: usa a Anthropic e envia só um id opaco do usuário', () => {
    const gw = new DirectAnthropicGateway({ apiKey: 'sk-test' });
    expect(gw.client().baseURL).toBe('https://api.anthropic.com');
    const { body } = gw.requestExtras(caller);
    const userId = (body?.metadata as { user_id: string }).user_id;
    expect(userId).toMatch(/^[0-9a-f]{32}$/);
    expect(userId).not.toContain('bruno');
    expect(body).not.toHaveProperty('litellm_metadata');
  });

  it('traduz credencial ausente em mensagem clara e não muda o modelo', () => {
    const gw = new DirectAnthropicGateway({});
    expect(
      gw.describeError(
        new Error(
          'Could not resolve authentication method. Expected the apiKey',
        ),
      ),
    ).toMatch(/ANTHROPIC_API_KEY/);
    expect(gw.describeError(new Error('outra coisa'))).toBeUndefined();
    expect(gw.model('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(gw.features().serverSideFallback).toBe(true);
  });
});
