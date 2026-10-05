# Railway build. The official Playwright image ships Chromium plus every system library it needs,
# so the graphic renderer (ai/design/renderer.js) works in production without a runtime download.
# Keep the tag in step with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx prisma generate

ENV NODE_ENV=production
CMD ["npm", "start"]
