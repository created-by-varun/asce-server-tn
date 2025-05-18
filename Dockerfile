FROM node:18-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package.json yarn.lock ./

# Install dependencies with NPM instead of Yarn for better Railway compatibility
RUN npm install

# Copy source files
COPY . .

# Build the application
RUN npm run build

# Expose application port
EXPOSE 3000

CMD ["node", "dist/main.js"]
