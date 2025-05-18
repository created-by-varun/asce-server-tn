FROM node:18

WORKDIR /app

# Copy package files first for better caching
COPY package.json yarn.lock ./

# Install dependencies using Yarn (original approach)
RUN yarn install

# Copy source files
COPY . .

# Build the application
RUN yarn build

# Expose application port
EXPOSE 3000

CMD ["node", "dist/main.js"]
