import { createFrontendPlugin, PageBlueprint } from '@backstage/frontend-plugin-api';
import { RiSparkling2Line } from '@remixicon/react';
import { rootRouteRef } from './routes';

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

export const agentPlugin = createFrontendPlugin({
  pluginId: 'agent',
  extensions: [agentPage],
  routes: {
    root: rootRouteRef,
  },
});
