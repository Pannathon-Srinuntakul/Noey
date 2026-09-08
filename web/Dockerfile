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

FROM node:24-alpine AS build
WORKDIR /app

ARG VITE_BACKEND_URL=https://noey-api-production.up.railway.app
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html

# Into templates/, not conf.d/: the image's entrypoint runs envsubst over this
# and writes the result to conf.d, which is what lets the server bind the port
# the platform assigns at run time. See nginx.conf.template.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# The default for a plain `docker run`. Railway, Cloud Run and Heroku all
# override it, and the template follows whatever they set.
ENV PORT=80
EXPOSE 80
