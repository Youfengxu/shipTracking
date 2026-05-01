#!/usr/bin/env bash
set -e

git push
ssh k11-services "cd ~/coding/shipTracking && git pull && pm2 restart ship-tracker"
echo "Deployed."
