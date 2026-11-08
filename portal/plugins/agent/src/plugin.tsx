import { createFrontendPlugin, PageBlueprint } from '@backstage/frontend-plugin-api';
import { RiShieldCheckLine, RiSparkling2Line } from '@remixicon/react';
import { governanceRouteRef, rootRouteRef } from './routes';

/** Página do Platform Agent, montada na raiz do portal. */
export const agentPage = PageBlueprint.make({
  params: {
    path: '/',
    title: 'Agente',
    icon: <RiSparkling2Line size={20} />,
    routeRef: rootRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/AgentChatPage').then(m => <m.AgentChatPage />),
  },
});

/** Painel de governança de IA (visível para o time de plataforma). */
export const governancePage = PageBlueprint.make({
  name: 'governance',
  params: {
    path: '/governanca-ia',
    title: 'Governança de IA',
    icon: <RiShieldCheckLine size={20} />,
    routeRef: governanceRouteRef,
    noHeader: true,
    loader: () =>
      import('./components/GovernancePage').then(m => <m.GovernancePage />),
  },
});

export const agentPlugin = createFrontendPlugin({
  pluginId: 'agent',
  extensions: [agentPage, governancePage],
  routes: {
    root: rootRouteRef,
    governance: governanceRouteRef,
  },
});
