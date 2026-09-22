# Noey Studio admin dashboard (Next.js, `output: "standalone"`).
#
# No secrets and no environment-specific values are baked in: every setting
# (API_URL, ADMIN_URL, SITE_URL, PRICES_REVALIDATE_SECRET) is read at RUN
# time, server-side only — this app has no NEXT_PUBLIC_* values at all.
# Runs as the unprivileged `node` user.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3001

# The standalone server does not serve `public/` or `.next/static` on its own
# unless they sit next to it — copy both in.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3001
CMD ["node", "server.js"]
