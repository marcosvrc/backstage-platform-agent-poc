export interface Config {
  app?: {
    signIn?: {
      /**
       * Provedores da tela de login: oidc (SSO via Keycloak) e/ou guest (só desenvolvimento).
       * Padrão: [guest]
       * @visibility frontend
       */
      providers?: Array<'oidc' | 'guest'>;
    };
  };
}
