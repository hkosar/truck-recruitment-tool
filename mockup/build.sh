#!/usr/bin/env bash
# Assemble the self-contained, dependency-free mockup into a single index.html.
# The output is Artifact-compatible (page content only: inline <style>, a mount
# node, and inline <script> — no <html>/<head>/<body> wrapper) and also opens
# directly in any browser.
set -euo pipefail
cd "$(dirname "$0")"

OUT="index.html"
{
  echo '<style>'
  cat src/_brand.css src/styles.css src/_components.css
  echo '</style>'
  echo '<div id="app"></div>'
  echo '<script>'
  echo '"use strict";'
  cat src/geo.js src/data.js src/ui.js src/screens.js src/screens2.js src/main.js
  echo '</script>'
} > "$OUT"

echo "Built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
