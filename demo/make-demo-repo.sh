#!/bin/sh
# Build the demo repo: a broken release setup for publishing "pubready" itself, plus the fix as a patch.
set -eu
DEMO="${1:-/tmp/pubdemo}"
rm -rf "$DEMO" && mkdir -p "$DEMO/.github/workflows" && cd "$DEMO"
git init -q -b main
git remote add origin https://github.com/hamarshehmhmd/pubready.git
cat > package.json <<'J'
{
  "name": "pubready",
  "version": "0.1.0",
  "repository": "github:HamarshehMhmd/pubready",
  "scripts": {
    "test": "node --test",
    "release": "npm publish --provenance"
  }
}
J
cat > .github/workflows/ci.yml <<'J'
name: CI
on:
  push:
    branches: [main]
    tags: ['v*']
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm test
  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: test
    uses: ./.github/workflows/publish.yml
    secrets: inherit
J
cat > .github/workflows/publish.yml <<'J'
name: publish
on:
  workflow_call:
permissions:
  contents: read
jobs:
  npm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run release
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
J
git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "release workflow"
# the fix, as a patch next to the repo
sed -i 's/    needs: test/    needs: test\n    permissions:\n      contents: read\n      id-token: write/' .github/workflows/ci.yml
sed -i 's/^  contents: read$/  contents: read\n  id-token: write/; s/node-version: 22/node-version: 24/; /        env:/d; /NODE_AUTH_TOKEN/d' .github/workflows/publish.yml
sed -i 's/HamarshehMhmd/hamarshehmhmd/' package.json
git diff > "$DEMO/../pubdemo-fix.patch"
git checkout -q .
