# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "index.js"]
