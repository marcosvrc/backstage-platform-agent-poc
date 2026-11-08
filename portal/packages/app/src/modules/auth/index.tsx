import { OAuth2 } from '@backstage/core-app-api';
import {
  ApiBlueprint,
  BackstageIdentityApi,
  OpenIdConnectApi,
  ProfileInfoApi,
  SessionApi,
  configApiRef,
  createApiRef,
  createFrontendModule,
  discoveryApiRef,
  oauthRequestApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';

/** Login corporativo via OIDC (Keycloak). Provider "oidc" no auth-backend. */
export const oidcAuthApiRef = createApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
>().with({ id: 'auth.oidc' });

const oidcAuthApi = ApiBlueprint.make({
  name: 'oidc-auth',
  params: defineParams =>
    defineParams({
      api: oidcAuthApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        oauthRequestApi: oauthRequestApiRef,
        configApi: configApiRef,
      },
      factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
        OAuth2.create({
          configApi,
          discoveryApi,
          oauthRequestApi,
          provider: { id: 'oidc', title: 'Keycloak', icon: () => null },
          environment: configApi.getOptionalString('auth.environment'),
          defaultScopes: ['openid', 'profile', 'email', 'offline_access'],
        }),
    }),
});

/**
 * Tela de login. Os provedores vêm de `app.signIn.providers`:
 * - `oidc`: SSO corporativo (Keycloak). Entra automaticamente se já houver sessão.
 * - `guest`: só para desenvolvimento local (o backend recusa guest em produção).
 */
const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => {
      const { SignInPage } = await import('@backstage/core-components');
      return function CorporateSignInPage(props) {
        const configApi = useApi(configApiRef);
        const wanted = configApi.getOptionalStringArray('app.signIn.providers') ?? ['guest'];
        const providers = wanted.map(id =>
          id === 'oidc'
            ? {
                id: 'oidc-auth-provider',
                title: 'Login corporativo',
                message: 'Entre com sua conta da empresa (Keycloak)',
                apiRef: oidcAuthApiRef,
              }
            : ('guest' as const),
        );
        return <SignInPage {...props} auto={wanted.includes('oidc')} providers={providers} />;
      };
    },
  },
});

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [oidcAuthApi, signInPage],
});
