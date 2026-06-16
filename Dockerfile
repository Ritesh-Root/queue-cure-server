# Queue Cure '26 backend — production image
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install only production deps using the committed lockfile (reproducible, audited clean).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY src ./src

# Persistence directory. Mount a volume here to keep the queue across restarts:
#   docker run -v queue-data:/app/data ...
RUN mkdir -p /app/data && chown -R node:node /app
USER node

# Platforms usually inject PORT; default to 3000. The server reads process.env.PORT.
ENV PORT=3000
EXPOSE 3000

# Container healthcheck hits the /health endpoint (busybox wget ships with alpine).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "src/index.js"]
