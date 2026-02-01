#!/bin/bash

echo "🚀 Starting Oggy - Stage 0"
echo "=========================="
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop and try again."
    exit 1
fi

echo "✓ Docker is running"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from .env.example..."
    cp .env.example .env
    echo "✓ .env file created"
else
    echo "✓ .env file exists"
fi

echo ""
echo "🏗️  Building and starting services..."
echo ""

# Start Docker Compose
docker-compose up --build

# Note: Use Ctrl+C to stop all services
