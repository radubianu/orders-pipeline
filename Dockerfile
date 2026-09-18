FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# scripts/migrate.ts resolves migrations relative to its own compiled
# location (dist/scripts/migrate.js -> ../migrations), so this must land
# at dist/migrations, not /app/migrations, to match both the compiled and
# ts-node/tsx (source) layouts.
COPY migrations ./dist/migrations

# fly.toml's [processes] block selects the actual command per Machine
# group (web -> dist/src/server.js, worker -> dist/src/worker.js); this
# CMD is just a sane default for running the image directly.
CMD ["node", "dist/src/server.js"]
