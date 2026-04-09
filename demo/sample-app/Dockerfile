FROM node:20-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3001
HEALTHCHECK --interval=3s --timeout=3s --retries=10 \
  CMD wget --spider -q http://localhost:3001/health || exit 1
CMD ["node", "server.js"]
