// Issue 1378: the compose model a start or a rolling boot runs on.
//
// Pure parsing (Bun.YAML resolves the anchors and merge keys), so it runs in
// the unit job, which has no Docker. The rolling boot refuses when
// website-server would be recreated, so its block is pinned whole: any change
// to it changes `docker compose config --hash website-server` and fails here
// first. The hash itself (fad32a67… plain, c93432f5… with the stage overlay,
// dummy RM_INSTANCE and RM_INSTANCE_STATE_DIR) was checked unchanged by hand
// when this test was added.
import { expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

type Service = {
  init?: boolean;
  stop_grace_period?: string;
  depends_on?: string[] | Record<string, { condition?: string }>;
} & Record<string, unknown>;

async function services(): Promise<Record<string, Service>> {
  const text = await Bun.file(join(repoRoot, "docker-compose.yml")).text();
  return (Bun.YAML.parse(text) as { services: Record<string, Service> }).services;
}

function seconds(duration: string | undefined): number {
  const m = /^(\d+)s$/.exec(duration ?? "");
  if (!m) throw new Error(`unparsed stop_grace_period: ${duration}`);
  return Number(m[1]);
}

test("worker-analytics waits for a healthy api and outlasts its 30 s release window on stop", async () => {
  const w = (await services())["worker-analytics"]!;
  expect(w.depends_on).toMatchObject({
    postgres: { condition: "service_healthy" },
    api: { condition: "service_healthy" },
  });
  expect(seconds(w.stop_grace_period)).toBeGreaterThan(30);
});

test("the four bun services run under an init and carry a stop grace period", async () => {
  const s = await services();
  for (const name of ["api", "worker-analytics", "system-scheduler", "analytics-producer"]) {
    expect({ name, init: s[name]!.init }).toEqual({ name, init: true });
    expect(seconds(s[name]!.stop_grace_period)).toBeGreaterThan(10);
  }
});

test("website-server's compose block is unchanged, so a rolling boot never recreates it", async () => {
  const ws = (await services())["website-server"];
  expect(ws).toEqual({
    build: { context: "./website-server", dockerfile: "Dockerfile" },
    labels: {
      "robotmoney.env.hash": "${RM_STACK_ENV_HASH:-}",
      "robotmoney.env": "${RM_STACK_ENV_CLASS:-}",
      "robotmoney.smoke.project": "${SMOKE_PROJECT:-}",
      "robotmoney.instance": "${RM_INSTANCE:?RM_INSTANCE is required; bun smoke sets it from the resolved instance}",
    },
    volumes: [
      "${RM_INSTANCE_STATE_DIR:?RM_INSTANCE_STATE_DIR is required; bun smoke sets it to the instance's state directory}/web:/srv/web:ro",
    ],
    ports: ["8080"],
    depends_on: ["api"],
    restart: "unless-stopped",
    logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
    healthcheck: {
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"],
      interval: "15s",
      timeout: "5s",
      retries: 3,
      start_period: "10s",
    },
  });
});
