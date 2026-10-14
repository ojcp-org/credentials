# The OJCP sandbox. Build from the repository root:
#   docker build -f services/sandbox/Dockerfile -t ojcp-sandbox .
# Serves plain HTTP on $PORT; a load balancer in front terminates TLS for
# sandbox.<domain>, *.sandbox.<domain> and *.ats.sandbox.<domain>.

FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "@ojcp/sandbox..." build
RUN pnpm --filter @ojcp/sandbox deploy --legacy --prod /out

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]
