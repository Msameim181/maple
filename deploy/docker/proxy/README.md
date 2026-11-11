# Choosing the reverse proxy

Maple needs five public HTTPS hostnames (app, api, sync, auth, ingest) in front of the stack.
Pick the option that matches the server:

| Server already has… | Use | Start the stack with |
|---|---|---|
| Neither Nginx nor Caddy | **A. Caddy in Docker** (default) | `docker compose up -d` |
| Caddy as a system service | **B. Host Caddy** | `docker compose -f docker-compose.yml -f docker-compose.host-proxy.yml up -d` |
| Nginx as a system service | **C. Host Nginx** | `docker compose -f docker-compose.yml -f docker-compose.host-proxy.yml up -d` |

In B and C the stack publishes nothing publicly. Each service listens on loopback only, and the host
proxy (which owns ports 80/443 and the certificates) forwards to it:

| Hostname | Loopback upstream | Notes |
|---|---|---|
| `APP_HOST` | `127.0.0.1:8780` | dashboard (static files) |
| `API_HOST` | `127.0.0.1:8701` | API; some responses stream |
| `SYNC_HOST` | `127.0.0.1:8705` | live sync, long polls: no buffering, 300 s timeout |
| `AUTH_HOST` | `127.0.0.1:8080` | Keycloak; needs `X-Forwarded-*` headers |
| `INGEST_HOST` | `127.0.0.1:3474` (HTTP), `127.0.0.1:4317` (gRPC) | OTLP from your apps; bodies up to 20 MB |

Change a port by setting `WEB_PORT`, `API_PORT`, `SYNC_PORT`, `AUTH_PORT` or `INGEST_PORT` in `.env`.

## A. Caddy in Docker (nothing installed on the server)

Nothing to configure. The `caddy` service listens on 80/443 and gets Let's Encrypt certificates for
the five hostnames in `.env`. The DNS records must point at the server and ports 80 and 443 must be
open, before the first start.

## B. Caddy installed on the server

1. Copy `caddy/Caddyfile.host` and replace the five `*.example.com` names with yours.
2. Install it:
   - put it at `/etc/caddy/Caddyfile`, or
   - add `import /etc/caddy/maple.caddy` to the existing Caddyfile and save the file there.
3. `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`

Caddy issues and renews the certificates by itself.

## C. Nginx installed on the server

1. **Certificates** (one certificate for all five names, via certbot):
   ```bash
   sudo apt install -y certbot python3-certbot-nginx gettext-base
   sudo certbot certonly --nginx \
     -d maple.example.com -d api.maple.example.com -d sync.maple.example.com \
     -d auth.maple.example.com -d ingest.maple.example.com
   ```
   The certificate lands in `/etc/letsencrypt/live/<APP_HOST>/`. Renewal is automatic (`certbot.timer`).
2. **Render the config** with your hostnames, from `deploy/docker/`:
   ```bash
   set -a; . ./.env; set +a
   envsubst '$APP_HOST $API_HOST $SYNC_HOST $AUTH_HOST $INGEST_HOST' \
     < proxy/nginx/maple.conf.template | sudo tee /etc/nginx/conf.d/maple.conf >/dev/null
   ```
   On Debian/Ubuntu layouts you can use `/etc/nginx/sites-available/maple.conf` plus a symlink in
   `sites-enabled/` instead.
3. `sudo nginx -t && sudo systemctl reload nginx`

The template needs Nginx 1.25.1+ for `http2 on;`. On older Nginx, delete those lines and write
`listen 443 ssl http2;` instead.

## Checking any option

```bash
curl -s https://$API_HOST/health                     # OK
curl -s https://$AUTH_HOST/realms/maple | head -c 80 # {"realm":"maple",...
curl -s -o /dev/null -w '%{http_code}\n' https://$APP_HOST   # 200
```
