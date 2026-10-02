# Builds the whole workspace, runs the delivery worker.
FROM node:22-alpine AS build
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

# Copy the lockfile too and install frozen, so a deploy ships the EXACT versions
# that were tested — never a fresh resolution of every ^range at build time.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @paedavic/database generate
RUN pnpm build

FROM node:22-alpine AS runtime
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
USER node
CMD ["node", "apps/worker/dist/main.js"]
