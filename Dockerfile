FROM node:22-alpine AS base
# Prisma needs openssl on Alpine — it's not included in node:22-alpine by default
# and the query engine fails to load without it.
RUN apk add --no-cache openssl
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package*.json ./
COPY extensions/ww-badges-embed/package.json ./extensions/ww-badges-embed/
RUN npm ci

# Generate Prisma client
FROM deps AS prisma
COPY prisma ./prisma/
RUN npx prisma generate

# Build the app
FROM prisma AS builder
COPY . .
RUN npm run build

# Production image
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

EXPOSE 3000

CMD ["npm", "run", "docker-start"]
