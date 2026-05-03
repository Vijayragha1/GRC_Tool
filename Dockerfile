FROM node:20-alpine

WORKDIR /app

# Build deps for better-sqlite3
RUN apk add --no-cache python3 make g++ \
 && ln -sf /usr/bin/python3 /usr/bin/python

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Persist DB and uploads via volume mount
VOLUME ["/app/data", "/app/uploads"]
ENV DB_PATH=/app/data/iso27001.db
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
