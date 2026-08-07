# Built from the monorepo ROOT (see docker-compose `build.context: ../..`). The app
# depends on the workspace @chainsafe/x402-* packages, so we install the workspace and
# build those packages, then run the bureau with tsx. (Once the packages are published
# to npm, this could install them directly instead of building from source.)
FROM node:20-slim
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --no-frozen-lockfile \
 && pnpm -r --filter "./packages/*" build

WORKDIR /repo/examples/mortgage/credit-bureau
CMD ["pnpm", "start"]
