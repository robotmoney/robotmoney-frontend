# Plain static file server for the assembled marketing/SPA/docs site
# (issue #892). No Bun, no Node, no app layer: the instance's `web/` directory
# (one assembled site per version, `current` naming the served one;
# scripts/lib/smoke-site.ts) is bind-mounted in read-only at runtime by
# docker-compose.yml, and `bun smoke:web` switches the site from the host with
# an `nginx -s reload` (scripts/lib/website-release.ts). This image carries
# only nginx and the fallback/proxy rule in nginx.conf, so `docker history`
# shows no application runtime — see nginx.conf for what the rule replicates
# and why /api + /health are proxied to the api service.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
