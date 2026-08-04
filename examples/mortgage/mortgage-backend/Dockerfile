# Built from the monorepo ROOT (see docker-compose `build.context: ../..`). Installs the
# workspace, builds the @chainsafe/x402-* packages, then runs the backend with tsx.
FROM node:20-slim
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile \
 && pnpm -r --filter "./packages/*" build

WORKDIR /repo/examples/mortgage/mortgage-backend
CMD ["pnpm", "start"]
