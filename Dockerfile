FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@0.116.0

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY public ./public
COPY server ./server
COPY fixtures ./fixtures
COPY README.md LICENSE ./

ENV HOST=0.0.0.0
ENV PORT=29000
ENV CODEX_SWITCHER_DATA_DIR=/data

CMD ["node", "server/app.js"]
