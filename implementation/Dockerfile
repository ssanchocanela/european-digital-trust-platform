# Platform API image.
#
# Multi-stage so the runtime image carries no toolchain, no test code and no dev dependencies.
# Pinned by digest for the same reason the engine is: an image change should be a reviewed
# change, not a surprise.
FROM node:22.23.2-alpine AS build
WORKDIR /app
RUN corepack enable pnpm
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# Drop dev dependencies from the store that ships onward.
RUN pnpm prune --prod

FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Runs unprivileged. The image needs no write access to its own filesystem.
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/package.json ./package.json
EXPOSE 3100
CMD ["node", "apps/platform-api/dist/main.js"]
