FROM node:22-alpine

WORKDIR /app

# Build deps for better-sqlite3 + runtime deps for Puppeteer's headless
# Chromium. On Alpine we install the system chromium instead of letting
# Puppeteer download its bundled build (which is glibc-linked and wouldn't
# run on musl anyway). The system chromium needs the listed fonts + libs.
RUN apk add --no-cache \
      python3 make g++ \
      chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont \
 && ln -sf /usr/bin/python3 /usr/bin/python

# Tell Puppeteer to skip its bundled Chromium download (saves ~170 MB at
# build time + sidesteps glibc-vs-musl) and use the system chromium.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Persist DB and uploads via volume mount
VOLUME ["/app/data", "/app/uploads"]
ENV DB_PATH=/app/data/iso27001.db
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
