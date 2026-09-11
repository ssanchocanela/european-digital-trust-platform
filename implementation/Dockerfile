# Platform image — the API, and the two optional web processes.
#
# One image, three entry points. The build compiles the whole workspace, so the operator console
# (`apps/operator-console`) and the public start page (`apps/test-start`) are already inside it and are
# selected by overriding the command. A second image would have to be kept in step with this one for no
# benefit; the processes differ in which port they bind and which secrets they hold, not in their code.
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
# The API's port. The console (3200) and the start page (3201) are published by compose, which sets
# their command; `EXPOSE` here documents the default entry point only.
EXPOSE 3100
CMD ["node", "apps/platform-api/dist/main.js"]
