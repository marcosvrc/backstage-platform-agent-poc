# Imagem do portal (Backstage + Platform Agent).
#
# Build em duas etapas: o código é compilado fora do Docker (CI ou máquina local),
# e esta imagem só instala as dependências de produção e copia o bundle.
#
#   cd portal && yarn install --immutable && yarn tsc && yarn build:backend && cd ..
#   docker build -t backstage-portal .
#
# Contexto: raiz do repositório (o .dockerignore só deixa entrar o necessário).

# 1. Dependências de produção (precisa de compilador para módulos nativos, ex.: isolated-vm)
FROM node:22-bookworm-slim AS deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 g++ make libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /app
COPY --chown=node:node portal/.yarn ./.yarn
COPY --chown=node:node portal/.yarnrc.yml portal/backstage.json portal/yarn.lock portal/package.json ./
COPY --chown=node:node portal/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz
RUN --mount=type=cache,target=/home/node/.cache/yarn,sharing=locked,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache clean)"

# 2. Imagem final
FROM node:22-bookworm-slim
# TechDocs sem Docker no cluster: mkdocs com o tema/plugins do Backstage num venv.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv libsqlite3-0 tini && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/mkdocs && \
    /opt/mkdocs/bin/pip install --no-cache-dir mkdocs-techdocs-core==1.7.1
ENV PATH="/opt/mkdocs/bin:${PATH}" \
    NODE_ENV=production \
    NODE_OPTIONS="--no-node-snapshot"
USER node
WORKDIR /app
COPY --from=deps --chown=node:node /app ./
COPY --chown=node:node portal/packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz
# Config sem segredos + catálogo da plataforma (sistema e inventário de IA) + golden paths.
COPY --chown=node:node portal/app-config.yaml portal/app-config.production.yaml ./
COPY --chown=node:node catalog/platform ./catalog/platform
COPY --chown=node:node catalog/ai ./catalog/ai
COPY --chown=node:node templates ./templates
EXPOSE 7007
ENTRYPOINT ["/usr/bin/tini", "--"]
# O chart acrescenta --config /etc/backstage/app-config.deploy.yaml (opções do ambiente).
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]
