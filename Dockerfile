FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
COPY remux-cache.cjs remux.cjs server.cjs extractor.cjs media-info.cjs index.html app.js ./
COPY public ./public
USER node
CMD ["node", "server.cjs"]
