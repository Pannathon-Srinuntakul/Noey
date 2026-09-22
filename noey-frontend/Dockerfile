# Noey Studio marketing + account site (Next.js, `output: "standalone"`).
#
# Two things here are load-bearing and easy to get wrong:
#
#   1. NEXT_PUBLIC_* values are BUILD-time. Next inlines them into the client
#      bundle and the prerendered pages (canonicals, sitemap, JSON-LD), so
#      changing the public site URL, app URL or Turnstile key means rebuilding
#      the image, not restarting the container. They are build args for that
#      reason.
#
#   2. Server-only values (API_URL, CONTACT_EMAIL, *_SITE_VERIFICATION,
#      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY) are read at RUN time — pass them to
#      the container, never bake them in here.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app

ARG NEXT_PUBLIC_SITE_URL=https://noeystudio.com
# Where the editor (web/) is served today (2026-09-22). Pass the real value as
# a build arg once the editor has its own domain.
ARG NEXT_PUBLIC_APP_URL=https://noey-frontend-production.up.railway.app
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# The standalone server does not serve `public/` or `.next/static` on its own
# unless they sit next to it — copy both in.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node

# The default for a plain `docker run`. Railway and similar platforms set PORT
# at run time and server.js follows it.
EXPOSE 3000
CMD ["node", "server.js"]
