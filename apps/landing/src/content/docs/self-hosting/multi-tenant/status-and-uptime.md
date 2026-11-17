---
title: "Status pages and uptime"
description: "How public status pages are published and linked, how the scraper runs uptime monitors, and why monitors can stay pending."
navLabel: "Status and uptime"
group: "Multi-tenant self-hosting"
order: 7
---

## Status pages

The `status` Worker runs inside the `maple` container and listens on port 8706. Caddy serves it on `STATUS_HOST` (for example `status.maple.example.com`).

1. An `engineer` or above creates a status page in the dashboard and publishes it.
2. The published page is available at `https://STATUS_HOST/s/<slug>`.
3. The dashboard builds the link to the public page from `STATUS_HOST`. The web build gets it as `PUBLIC_STATUS_URL` and the `maple` service gets it as `MAPLE_STATUS_PAGE_BASE_URL` (`https://${STATUS_HOST}`).

Because the status URL is baked into the dashboard at build time, changing `STATUS_HOST` needs a rebuild: `docker compose build caddy maple && docker compose up -d`.

If the link is missing in the dashboard, the web image was built without `STATUS_HOST`. See [Troubleshooting](/docs/self-hosting/multi-tenant/troubleshooting#status-link-missing).

## The scraper

The `scraper` service runs uptime monitors and Prometheus scrape targets.

```
 scraper --GET /api/internal/uptime-targets--> maple:8701   (compose network only,
    |            Authorization: SD_INTERNAL_TOKEN             404 through Caddy)
    |-- runs each check from the scraper container
    |-- POST results --> maple:8701 /api/internal/uptime-results
    |-- scraped metrics --> ingest:3474 (OTLP, per-org public key)
```

- It talks to the API on `http://maple:8701`, never through Caddy, because Caddy hides `/api/internal/*` from the internet.
- Both sides need the same `SD_INTERNAL_TOKEN`. If it is unset on `maple`, the results endpoint answers `401` and monitors never leave `pending`.
- The target list is refreshed every `SCRAPER_RECONCILE_INTERVAL_SECONDS` (default 60).

## Why a monitor stays "pending"

A new monitor is `pending` until the scraper reports its first result. It stays pending when:

1. The `scraper` service is not running: `docker compose ps scraper`.
2. `SD_INTERNAL_TOKEN` differs between `maple` and `scraper`, or is empty. Check `docker compose logs scraper` for `401`.
3. **The target is private.** The scraper refuses private and internal addresses (private IP ranges, loopback, and internal hostnames). This is a safety rule: otherwise a monitor could be pointed at internal services such as Keycloak or Electric.

The monitor form's **Test** button runs inside the API process, so it can pass for a target the scraper will still refuse. A target that tests fine but stays pending is almost always the private-address rule. Monitor public URLs, or expose the service through a public hostname. The scraper's own settings are in the [configuration reference](/docs/self-hosting/multi-tenant/configuration#scraper-environment).
