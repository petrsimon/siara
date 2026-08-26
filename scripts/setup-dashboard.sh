#!/bin/bash
set -e

echo "=== Siara Dashboard Publishing Setup ==="
echo ""

# Generate a new encryption key
NEW_KEY=$(openssl rand -base64 32)
export SIARA_LOG_KEY="$NEW_KEY"

echo "✓ Generated new encryption key"

# Update GitHub secrets
echo "✓ Updating GitHub secret SIARA_LOG_KEY..."
gh secret set SIARA_LOG_KEY --body "$SIARA_LOG_KEY"

echo "✓ Setting dashboard viewer password..."
gh secret set DASHBOARD_PASSWORD --body "siara-dashboard-2026"

echo "✓ Encrypting data bundle..."
./scripts/log-crypt.sh encrypt

echo "✓ Encrypted data.enc created ($(du -h data.enc | cut -f1))"

echo ""
echo "=== Ready to Publish ==="
echo "Run these commands to publish:"
echo ""
echo "  git add data.enc"
echo "  git commit -m 'chore: update encrypted fairness log for dashboard'"
echo "  git push"
echo ""
echo "Dashboard will be live at: https://petrsimon.github.io/siara/"
echo "Viewer password: siara-dashboard-2026"
