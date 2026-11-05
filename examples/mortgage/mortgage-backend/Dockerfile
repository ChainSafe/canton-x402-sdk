# Built from the monorepo ROOT (see docker-compose `build.context: ../..`). Installs the
# workspace, builds the @chainsafe/x402-* packages, then runs the backend with tsx.
FROM node:26-slim
# Node 25+ no longer ships corepack, so pnpm comes from npm, pinned to
# package.json's "packageManager".
RUN npm install -g pnpm@10.32.0
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile \
 && pnpm -r --filter "./packages/*" build

WORKDIR /repo/examples/mortgage/mortgage-backend
CMD ["pnpm", "start"]
