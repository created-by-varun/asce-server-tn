#!/bin/bash

# Exit on error
set -e

echo "🚀 Building and deploying AeroTropy Server..."

# Pull the latest changes
echo "📥 Pulling latest changes from repository..."
git pull

# Build the Docker image
echo "🔨 Building Docker image..."
docker-compose build

# Stop existing containers
echo "🛑 Stopping existing containers..."
docker-compose down

# Start new containers
echo "🌟 Starting new containers..."
docker-compose up -d

echo "✅ Deployment completed successfully!"
echo "🔍 View logs with: docker-compose logs -f"
