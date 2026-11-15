# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json

# Copy optional apps/web/package.json if present (wildcard avoids failing when absent)
COPY apps/web/package.json* apps/web/

RUN npm ci --workspaces --if-present

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web* apps/web/

RUN npm run build --workspace=packages/shared
RUN if [ -f apps/web/package.json ]; then npm run build --workspace=apps/web; fi
RUN npm run build --workspace=apps/server

FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json

RUN npm ci --omit=dev --workspace=packages/shared --workspace=apps/server && npm cache clean --force

COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/apps/web/dist* apps/web/dist/

EXPOSE 8080

CMD ["node", "apps/server/dist/index.js"]
