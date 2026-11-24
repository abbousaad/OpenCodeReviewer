#!/bin/bash
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Starting OpenCodeReviewer dashboard on http://127.0.0.1:3000 ..."
node -v || { echo "Node 22+ not found"; read -p "Press Enter"; exit 1; }
( sleep 3; open http://127.0.0.1:3000 ) &
npm start
read -p "Server stopped. Press Enter to close."
