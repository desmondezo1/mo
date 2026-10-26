# Mo's backend, hosted. The server has no runtime dependencies, so the image is just Node
# plus server/ (including the demo pages the welcome screen's try-it uses).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 SHOWME_DATA_DIR=/data
COPY package.json ./
COPY server ./server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.js"]
