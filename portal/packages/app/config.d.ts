export interface Config {
  app?: {
    signIn?: {
      /**
       * Provedores da tela de login: oidc (SSO via Keycloak) e/ou guest (só desenvolvimento).
       * Padrão: [guest]
       * @visibility frontend
       */
      providers?: Array<'oidc' | 'guest'>;
      /** Textos do botão de SSO (oidc). */
      oidc?: {
        /**
         * Padrão: Login corporativo
         * @visibility frontend
         */
        title?: string;
        /**
         * Padrão: Entre com sua conta da empresa
         * @visibility frontend
         */
        message?: string;
      };
    };
  };
}
