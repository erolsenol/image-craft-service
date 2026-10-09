FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY package*.json .npmrc ./
COPY packages/client/package.json ./packages/client/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 CACHE_DIR=/var/cache/image-craft
WORKDIR /app
COPY package*.json .npmrc ./
COPY packages/client/package.json ./packages/client/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
RUN mkdir -p /var/cache/image-craft && chown -R node:node /app /var/cache/image-craft
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
