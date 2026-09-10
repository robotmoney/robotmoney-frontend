# Plain static file server for the assembled marketing/SPA/docs site
# (issue #892). No Bun, no Node, no app layer: `_static/` (scripts/
# static-assembly.sh) is bind-mounted in at runtime by docker-compose.yml, the
# same way it used to be mounted into the api container. This image carries
# only nginx and the fallback/proxy rule in nginx.conf, so `docker history`
# shows no application runtime — see nginx.conf for what the rule replicates
# and why /api + /health are proxied to the api service.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
