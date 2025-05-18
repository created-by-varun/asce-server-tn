FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy source files
COPY . .

# Build the application
RUN yarn build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

# Copy package files and install production-only dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma

# Expose application port
EXPOSE 3000

CMD ["node", "dist/main.js"]
