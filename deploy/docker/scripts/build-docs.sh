#!/bin/sh
# Builds the GitHub Pages site from the Maple docs Markdown (the single source) with MkDocs.
# Copies the folder to a temp dir, turns site links (/docs/self-hosting/multi-tenant/<page>) into
# relative <page>.md links, and runs `mkdocs build --strict`. Output: deploy/docker/site/
# Needs: pip install mkdocs-material
set -eu
cd "$(dirname "$0")/.."
src=../../apps/landing/src/content/docs/self-hosting/multi-tenant
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/docs"
cp "$src"/*.md "$tmp/docs/"
mv "$tmp/docs/overview.md" "$tmp/docs/index.md" # the site's home page
for f in "$tmp"/docs/*.md; do
	# /docs/self-hosting/multi-tenant/<page>[#anchor] -> <page>.md[#anchor]; the old name overview -> index
	sed -E -e 's#\]\(/docs/self-hosting/multi-tenant/overview([#)])#](index.md\1#g' \
		-e 's#\]\(/docs/self-hosting/multi-tenant/([a-z-]+)([#)])#](\1.md\2#g' \
		-e 's#\]\(/docs/#](https://maple.dev/docs/#g' "$f" > "$f.new" && mv "$f.new" "$f"
done
# MkDocs ignores the extra frontmatter keys (group, order, navLabel), so nothing is stripped.
sed -E "s#^docs_dir:.*#docs_dir: $tmp/docs#" mkdocs.yml > "$tmp/mkdocs.yml"
mkdocs build --strict -f "$tmp/mkdocs.yml" -d "$PWD/site"
