# Builds the whole workspace, runs the api app. (Shared base with worker.)
FROM node:22-alpine AS build
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

COPY pnpm-workspace.yaml package.json turbo.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @paedavic/database generate
RUN pnpm build

FROM node:22-alpine AS runtime
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
