FROM node:22-alpine

WORKDIR /app

# Build deps for better-sqlite3 + runtime deps for Puppeteer's headless
# Chromium. On Alpine we install the system chromium instead of letting
# Puppeteer download its bundled build (which is glibc-linked and wouldn't
# run on musl anyway). The system chromium needs the listed fonts + libs.
RUN apk add --no-cache \
      python3 make g++ \
      chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont \
      clamav \
 && ln -sf /usr/bin/python3 /usr/bin/python

# Fail the image build if the malware definitions cannot be initialised. The
# runtime upload gate defaults to fail-closed in production.
RUN freshclam

# Tell Puppeteer to skip its bundled Chromium download (saves ~170 MB at
# build time + sidesteps glibc-vs-musl) and use the system chromium.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    UPLOAD_AV_MODE=required \
    CLAMAV_BIN=/usr/bin/clamscan

COPY package*.json ./
RUN npm ci --omit=dev

# SEC-001: copy only what the runtime needs. A broad `COPY . .` puts .env,
# databases, keys, uploads and backups into an image layer even when the file
# is later removed, because layers are immutable. Keep this list explicit.
COPY server.js db.js ./
COPY routes/ ./routes/
COPY lib/ ./lib/
COPY views/ ./views/
COPY public/ ./public/
COPY data/ ./data/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

# Fail the build if a secret or data artifact reached the image anyway.
RUN set -e; \
    for f in .env .env.local iso27001.db data/master.key; do \
      if [ -e "/app/$f" ]; then echo "SEC-001: $f must not be in the image" >&2; exit 1; fi; \
    done; \
    if find /app -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' -o -name '*.key' -o -name '*.pem' -o -name '*.enc' \) -print | grep -q .; then \
      echo "SEC-001: database/key material found in image" >&2; \
      find /app -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' -o -name '*.key' -o -name '*.pem' -o -name '*.enc' \) -print >&2; exit 1; \
    fi

# The service runs without root privileges. Deployment creates bind-mounted
# directories with this UID/GID before startup; these image-owned directories
# cover anonymous-volume and non-compose use as well.
RUN mkdir -p /app/data/backups /app/uploads \
 && chown -R node:node /app/data /app/uploads \
 && chmod 0700 /app/data /app/data/backups /app/uploads

# Persist DB, encrypted backups and uploads via volume mounts.
VOLUME ["/app/data", "/app/uploads"]
ENV DB_PATH=/app/data/iso27001.db \
    ISMS_BACKUP_DIR=/app/data/backups \
    PORT=3000

# Email integration (Phase 1). Optional - if RESEND_API_KEY is unset
# the app writes outbound mail to /app/data/email-dev-outbox.log
# instead of sending. Set APP_BASE_URL to the externally-reachable URL
# so links in approval emails resolve to the right host.
# ENV RESEND_API_KEY=
# ENV EMAIL_FROM_DEFAULT="ISMS <noreply@example.com>"
# ENV APP_BASE_URL=https://isms.example.com

EXPOSE 3000

USER node:node

CMD ["node", "server.js"]
