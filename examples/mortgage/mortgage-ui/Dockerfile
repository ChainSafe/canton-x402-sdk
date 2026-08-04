# Built from the monorepo ROOT (see docker-compose `build.context: ../..`). The UI has no
# @chainsafe/x402-* dependency, but it lives in the pnpm workspace so we install + build it
# from the root, then serve the static bundle via nginx (which proxies /api → mortgage-backend).
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --no-frozen-lockfile \
 && pnpm --filter @chainsafe/x402-example-mortgage-ui build

FROM nginx:alpine
COPY examples/mortgage/mortgage-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/examples/mortgage/mortgage-ui/dist /usr/share/nginx/html
