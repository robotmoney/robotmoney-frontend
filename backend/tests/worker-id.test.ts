// A worker's DEFAULT id must be unique per container replica.
//
// The smoke scales the swarm lane (`docker compose up --scale worker-swarm=N`,
// scripts/lib/smoke-schedule.ts SmokeCadence.swarmWorkers) so concurrent
// sessions never queue a lifecycle job behind another subject's judge. The
// worker is each container's entrypoint, so its pid is 1 in EVERY replica, and
// the old `<lane>-<pid>` default named them all `swarm-1` — which defeats every
// `locked_by = workerId` ownership guard in worker/loop.ts (one replica's
// shutdown release would requeue another replica's in-flight job). Docker sets
// the hostname to the container id, so the hostname is what separates them.
import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { defaultWorkerId } from "../src/worker/runtime.ts";

test("two replicas with the same pid get different ids (the hostname separates them)", () => {
  const a = defaultWorkerId("swarm", "3f2a9c1b7d4e", 1);
  const b = defaultWorkerId("swarm", "8e1d0b6a2c5f", 1);
  expect(a).toBe("swarm-3f2a9c1b7d4e-1");
  expect(b).toBe("swarm-8e1d0b6a2c5f-1");
  expect(a).not.toBe(b);
});

test("the default still leads with the lane, so locked_by and logs name the lane", () => {
  expect(defaultWorkerId("analytics").startsWith("analytics-")).toBe(true);
  expect(defaultWorkerId("swarm")).toBe(`swarm-${hostname()}-${process.pid}`);
});
