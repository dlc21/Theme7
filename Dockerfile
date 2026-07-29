FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY vendor/*.tgz vendor/
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build \
  && rm -rf .next/standalone/scripts \
  && node scripts/materialize-runtime-files.mjs .runtime-surface --container

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ARG CODEX_VERSION=0.140.0
ARG BUN_VERSION=1.3.14
ARG OMP_VERSION=17.1.7
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client bash \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --no-audit --no-fund "bun@${BUN_VERSION}" "@oh-my-pi/pi-coding-agent@${OMP_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && omp --version \
  && codex --version \
  && npm cache clean --force
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOME=/data/home
ENV OPERATOR_ENGINE_HOST=0.0.0.0
ENV OPERATOR_ENGINE_PORT=4400
ENV OPERATOR_ENGINE_TERMINAL_HOST=0.0.0.0
ENV OPERATOR_ENGINE_TERMINAL_PORT=4401
ENV OPERATOR_ENGINE_DATA_DIR=/data
ENV OPERATOR_ENGINE_DB_PATH=/data/theme7.sqlite
ENV OPERATOR_ENGINE_WORKSPACE_ROOT=/data/workspace
ENV OPERATOR_ENGINE_STANDALONE=1
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
ENV OPERATOR_ENGINE_OMP_BIN=/usr/local/bin/omp
WORKDIR /app
RUN mkdir -p /data/home /data/workspace /data/recipes /data/editions /opt/bun && chown -R node:node /data /app /opt/bun
USER node
VOLUME ["/data"]
EXPOSE 4400 4401
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4400/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.runtime-surface ./
COPY --from=build --chown=node:node /app/recipes ./recipes
COPY --from=build --chown=node:node /app/editions ./editions
CMD ["node", "scripts/run.mjs", "start"]
