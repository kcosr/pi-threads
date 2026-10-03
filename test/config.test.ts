import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveClientConfig, resolveEndpoint } from "../src/config.ts";

describe("config", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "pi-threads-config-validation-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  }
  it("merges config files with defaults", () => {
    const dir = join(tmpdir(), `pi-threads-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        defaults: { model: "mock/default", thinking: "high" },
        daemon: { worker: { maxWorkers: 2 } },
        servers: {
          tcp: {
            endpoint: "ws://127.0.0.1:9999",
            authTokenEnv: "TOKEN_ENV",
            tlsCa: "/tmp/ca.pem",
          },
        },
      }),
    );
    const config = loadConfig(path);
    expect(config.defaults).toEqual({ model: "mock/default", thinking: "high" });
    expect(config.daemon.worker.maxWorkers).toBe(2);
    expect(config.daemon.worker.minWorkers).toBe(0);
    expect(resolveEndpoint({ config, server: "tcp" })).toBe("ws://127.0.0.1:9999");
    expect(resolveClientConfig({ config, server: "tcp" })).toEqual({
      endpoint: "ws://127.0.0.1:9999",
      authToken: undefined,
      authTokenEnv: "TOKEN_ENV",
      tlsCa: "/tmp/ca.pem",
    });
    expect(resolveClientConfig({ config, server: "tcp", authToken: "override" })).toEqual({
      endpoint: "ws://127.0.0.1:9999",
      authToken: "override",
      authTokenEnv: "TOKEN_ENV",
      tlsCa: "/tmp/ca.pem",
    });
  });

  it("validates default thinking levels", () => {
    const dir = join(tmpdir(), `pi-threads-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ defaults: { thinking: "giant" } }));

    expect(() => loadConfig(path)).toThrow(/defaults\.thinking/);
  });

  it("accepts Pi's max thinking level", () => {
    const dir = join(tmpdir(), `pi-threads-config-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ defaults: { thinking: "max" } }));

    expect(loadConfig(path).defaults.thinking).toBe("max");
  });

  it.each([
    ["maxWorkers", "4"],
    ["maxWorkers", 1.5],
    ["minWorkers", null],
    ["minWorkers", 0.5],
    ["idleTtlMs", "1000"],
    ["idleTtlMs", -1],
  ])("rejects invalid numeric worker config %s=%s", (key, value) => {
    const path = writeConfig({ daemon: { worker: { [key]: value } } });
    expect(() => loadConfig(path)).toThrow(`daemon.worker.${key}`);
  });

  it.each(["", null, 0])("rejects an invalid default thinking level %s", (thinking) => {
    expect(() => loadConfig(writeConfig({ defaults: { thinking } }))).toThrow("defaults.thinking");
  });

  it.each(["", "   ", null, 42])("rejects an invalid default model %s", (model) => {
    expect(() => loadConfig(writeConfig({ defaults: { model } }))).toThrow("defaults.model");
  });
});
