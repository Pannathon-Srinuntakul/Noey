# Noey Studio admin dashboard (Next.js, `output: "standalone"`).
#
# No secrets and no environment-specific values are baked in: every setting
# (API_URL, ADMIN_URL, SITE_URL, PRICES_REVALIDATE_SECRET, SENTRY_*) is read
# at RUN time, server-side only — this app has no NEXT_PUBLIC_* values at all
# (the browser Sentry config is handed over by the server; lib/sentry-config.ts).
# Runs as the unprivileged `node` user.

# Base images are pinned to a manifest-list digest (resolves on amd64 and arm64),
# not a moving tag: a push to main is a production deploy, so the base must not
# change under a commit that touched nothing. Bump deliberately:
#   docker buildx imagetools inspect <image:tag>   (digests fetched 2026-09-30)
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/ is empty in this app and git does not keep empty folders, so a
# checkout (Railway, CI) has none — and the run stage copies it. Make sure it
# exists instead of failing the build with "/app/public: not found".
RUN mkdir -p public && npm run build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS run
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
