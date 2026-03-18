#!/bin/bash
# 5StarFlow Backend Setup Script
# Run this once to install dependencies and initialize the database.

set -e

echo ""
echo "================================================"
echo "  5StarFlow Backend — First-time Setup"
echo "================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed."
  echo "Install it from https://nodejs.org (LTS version recommended)"
  exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js: $NODE_VERSION"

# Check npm
if ! command -v npm &> /dev/null; then
  echo "ERROR: npm not found. It should come bundled with Node.js."
  exit 1
fi

echo "npm: $(npm --version)"
echo ""

# Step 1: Install dependencies
echo "[1/4] Installing dependencies..."
npm install

# Step 2: Copy .env if it doesn't exist
if [ ! -f ".env" ]; then
  echo ""
  echo "[2/4] Creating .env from template..."
  cp .env.example .env
  echo "  --> .env created. Open it and fill in your Jobber credentials before starting."
else
  echo "[2/4] .env already exists — skipping."
fi

# Step 3: Generate Prisma client
echo ""
echo "[3/4] Generating Prisma client..."
npx prisma generate

# Step 4: Run migrations (creates dev.db)
echo ""
echo "[4/4] Running database migrations..."
npx prisma migrate dev --name init

echo ""
echo "================================================"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Edit .env and add your Jobber credentials"
echo "  2. Run:  npm run dev"
echo "  3. Open: http://localhost:3001/dashboard.html"
echo "================================================"
echo ""
