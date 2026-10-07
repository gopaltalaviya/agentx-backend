# One server: the live deployment

The backend as it runs today: one Ubuntu VPS (2 vCPU / 4 GB), the production
images from `docker-compose.full.yml`, and Caddy in front for HTTPS. The site
is on Vercel. Full steps: agentx-docs, `docs/13-deploy.md` §5.

| File | What it does |
|---|---|
| `bootstrap-ubuntu.sh` | firewall (22, 80, 443 only), Docker, 2 GB swap, automatic security updates |
| `docker-compose.vps.yml` | Postgres and the API publish no port; Caddy alone listens on 80/443 |
| `Caddyfile` | HTTPS for `API_HOST`, certificate from Let's Encrypt, live events unbuffered |

```bash
docker compose -f docker-compose.full.yml -f docker-compose.vps.yml --profile hosted up -d --no-build
```

The server's `.env` holds `SIGNER_TOKEN`, `API_HOST` (e.g. `api.1-2-3-4.sslip.io`),
`CORS_ORIGINS` (the site's URL) and the hosted-run variables of §3b. It is
never committed.
