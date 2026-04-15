#!/bin/bash
# WW Badges — First-time setup
# Run this once from the ww-badges directory:
#   cd "ww-badges" && chmod +x setup.sh && ./setup.sh

set -e

echo "📦 Installing dependencies..."
npm install

echo "🗄  Setting up database..."
npx prisma generate
npx prisma migrate dev --name init

echo "✅ Setup complete!"
echo ""
echo "▶️  To start the dev server, run:"
echo "   npm run dev"
echo ""
echo "   This will open a tunnel and prompt you to install the app"
echo "   on the win-win-ccae-dev store."
