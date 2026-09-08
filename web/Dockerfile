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
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
