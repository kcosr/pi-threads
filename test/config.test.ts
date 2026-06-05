import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveEndpoint } from "../src/config.ts";

describe("config", () => {
  it("merges config files with defaults", () => {
    const dir = join(tmpdir(), `pi-threads-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        daemon: { worker: { maxWorkers: 2 } },
        servers: { tcp: { endpoint: "ws://127.0.0.1:9999" } },
      }),
    );
    const config = loadConfig(path);
    expect(config.daemon.worker.maxWorkers).toBe(2);
    expect(config.daemon.worker.minWorkers).toBe(0);
    expect(resolveEndpoint({ config, server: "tcp" })).toBe("ws://127.0.0.1:9999");
  });
});
