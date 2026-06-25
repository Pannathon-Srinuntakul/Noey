# Frontend image — Vite build + npm start (serve SPA). Set VITE_API_URL for production API URL.
FROM node:24-alpine
WORKDIR /app
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
ENV PORT=3000
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
