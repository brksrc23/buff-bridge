FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY vendor ./vendor
RUN npm ci --omit=dev
COPY . .
ENV NODE_OPTIONS=--max-old-space-size=192
ENV MEM_SKIP_RSS_MB=200
EXPOSE 8787
CMD ["npm", "run", "start"]
