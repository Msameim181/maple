#!/usr/bin/env node
// Post-build step for the GitHub Pages copy of the docs site, which is served under a sub-path
// (https://<user>.github.io/<repo>/). Astro's `base` prefixes the assets and routes it generates,
// but links written by hand in Markdown, components and a few client scripts stay root-relative
// (`/docs/...`) and would 404 under the sub-path. This prefixes them in the built output.
//
// Usage: node scripts/pages-base.mjs <dist-dir> <base>      e.g. dist /maple
// Safe to run twice: anything already under the base is left alone.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [dist, rawBase] = process.argv.slice(2)
if (!dist || !rawBase) {
	console.error("usage: pages-base.mjs <dist-dir> <base>")
	process.exit(2)
}
const base = `/${rawBase.replace(/^\/+|\/+$/g, "")}`
const bare = base.slice(1)

// A root-relative URL that is not protocol-relative (`//host`) and not already under the base.
const needsBase = `/(?!/)(?!${bare}(?:/|$|["'?#\\s]))`

// An opening tag, with quoted attribute values that may contain ">".
const tag = /<[a-zA-Z][^\s>/]*(?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g
// href="/x", src='/x', action, poster, data-*="/x"
const attr = new RegExp(`(\\s(?:href|src|action|poster|data-[a-z-]+)=)(["'])${needsBase}`, "g")
// meta refresh: content="0;url=/x"
const refresh = new RegExp(`(url=)${needsBase}`, "gi")
// srcset / imagesrcset: every URL in the comma list
const srcset = /(\s(?:srcset|imagesrcset)=)(["'])([^"']*)\2/g
// Markdown twins and similar: ](/x)
const mdLink = new RegExp(`(\\]\\()${needsBase}`, "g")
// The search index: "url":"/x"
const jsonUrl = new RegExp(`("url":")${needsBase}`, "g")
// Built client scripts: only the known site routes, in string literals.
const jsLiteral = new RegExp(
	`(["'\`])/(?!${bare}/)(docs|features|guides|changelog|blog|about|brand|compare|alternatives|customers|use-cases|skills|integrations)(?=[/"'\`$?#])`,
	"g",
)

// Site code that builds canonical / hreflang / locale-switch URLs from `base + pathname` adds the
// base a second time: /maple/maple/x and /maple/ja/maple/x. Collapse both.
const doubled = new RegExp(`${base}${base}(?=["'/?#\\s]|$)`, "g")
const doubledLocale = new RegExp(`/(ja|ko)${base}(?=["'/?#\\s]|$)`, "g")

const prefix = (url) =>
	url.startsWith("/") && !url.startsWith("//") && !url.startsWith(`${base}/`) ? base + url : url

const rewrite = (path, text) => {
	if (path.endsWith(".html")) {
		// Only inside real tags: a code sample that merely contains `src="/x"` as text stays as written.
		return text
			.replace(tag, (t) =>
				t
					.replace(attr, (_, a, q) => `${a}${q}${base}/`)
					.replace(refresh, (_, u) => `${u}${base}/`)
					.replace(srcset, (_, a, q, list) => {
						const mapped = list
							.split(",")
							.map((part) => {
								const [url, ...rest] = part.trim().split(/\s+/)
								return [prefix(url ?? ""), ...rest].join(" ")
							})
							.join(", ")
						return `${a}${q}${mapped}${q}`
					}),
			)
			.replace(doubledLocale, "/$1")
			.replace(doubled, base)
	}
	if (path.endsWith(".md")) return text.replace(mdLink, (_, a) => `${a}${base}/`)
	if (path.endsWith("search-index.json")) return text.replace(jsonUrl, (_, a) => `${a}${base}/`)
	if (path.endsWith(".js") && path.includes("/_astro/")) {
		return text.replace(jsLiteral, (_, q, route) => `${q}${base}/${route}`)
	}
	return text
}

let changed = 0
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) walk(path)
		else if (/\.(html|md|js|json)$/.test(name)) {
			const before = readFileSync(path, "utf8")
			const after = rewrite(path, before)
			if (after !== before) {
				writeFileSync(path, after)
				changed += 1
			}
		}
	}
}
walk(dist)
console.log(`pages-base: rewrote ${changed} files under ${dist} for base ${base}`)
