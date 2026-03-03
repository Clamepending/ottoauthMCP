FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=8004
EXPOSE 8004

CMD ["node", "src/http-bridge.mjs"]
