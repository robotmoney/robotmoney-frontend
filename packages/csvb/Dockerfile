# csvb-backup (issue 1608): the scheduled archive backup, `csvb serve`. Build context is the repo ROOT, like every
# service in docker-compose.yml, but the image copies ONLY packages/csvb and packages/analyst-sdk (D80): the tool and
# the format module it writes with. It never contains, and never runs, anything from robotmoney/csv-backups, which
# holds data only; the container clones that repo at run time and stages and commits csv/** in it.
#
# git and an ssh client are the push path (a deploy key file mounted read-only). The image is oven/bun:1.4.4 like
# the rest, Debian-based, with no curl: the healthcheck is `bun -e`.
FROM oven/bun:1.4.4

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/packages/csvb

# csvb depends on the SDK by path (`file:../analyst-sdk`), so the two sit side by side as they do in the repo.
COPY packages/analyst-sdk/package.json /app/packages/analyst-sdk/package.json
COPY packages/analyst-sdk/src/ /app/packages/analyst-sdk/src/
COPY packages/csvb/package.json packages/csvb/bun.lock /app/packages/csvb/
RUN bun install --frozen-lockfile --production
COPY packages/csvb/src/ /app/packages/csvb/src/

# The command and its settings come from the compose service.
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["serve"]
