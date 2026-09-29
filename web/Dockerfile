# The browser build: a static site plus one service worker.
#
# Two things here are load-bearing and easy to get wrong:
#
#   1. `npm ci` WITHOUT --omit=dev. The build needs vite, tailwind, typescript
#      and the type packages, all of which are devDependencies. There is no
#      runtime install — the second stage copies compiled files only.
#
#   2. VITE_BACKEND_URL is a BUILD-time value. It is baked into the bundle AND
#      into the page's Content-Security-Policy (see vite.config.ts), so
#      changing which API this build talks to means rebuilding the image, not
#      restarting the container.

# Base images are pinned to a manifest-list digest (resolves on amd64 and arm64),
# not a moving tag: a push to main is a production deploy, so the base must not
# change under a commit that touched nothing. Bump deliberately:
#   docker buildx imagetools inspect <image:tag>   (digests fetched 2026-09-30)
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app

ARG VITE_BACKEND_URL=https://noey-api-production.up.railway.app
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
# The bucket presigned uploads go to (see vite.config.ts). Empty = none.
ARG VITE_UPLOAD_ORIGIN=
ENV VITE_UPLOAD_ORIGIN=$VITE_UPLOAD_ORIGIN
# Error monitoring (src/lib/monitoring.ts). Empty = off. Its ingest origin is
# added to the CSP only when set (vite.config.ts).
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ARG VITE_SENTRY_ENVIRONMENT=
ENV VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT
ARG VITE_SENTRY_RELEASE=
ENV VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY --from=build /app/dist /usr/share/nginx/html

# Into templates/, not conf.d/: the image's entrypoint runs envsubst over this
# and writes the result to conf.d, which is what lets the server bind the port
# the platform assigns at run time. See nginx.conf.template.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# The default for a plain `docker run`. Railway, Cloud Run and Heroku all
# override it, and the template follows whatever they set.
ENV PORT=80
EXPOSE 80
