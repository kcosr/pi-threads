import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface PiThreadsConfig {
  defaults: {
    model?: string;
    thinking?: string;
  };
  daemon: {
    unixSocket: string;
    worker: {
      minWorkers: number;
      maxWorkers: number;
      idleTtlMs: number;
    };
    tcp: {
      enabled: boolean;
      bind: string;
      port: number;
      authToken?: string;
      authTokenEnv?: string;
      allowedOrigins: string[];
      tls?: {
        ca?: string;
        cert?: string;
        key?: string;
      };
    };
  };
  servers: Record<
    string,
    {
      endpoint: string;
      authToken?: string;
      authTokenEnv?: string;
      tlsCa?: string;
    }
  >;
}

export function defaultConfigPath(): string {
  return resolve(homedir(), ".config", "pi-threads", "config.json");
}

export function defaultConfig(): PiThreadsConfig {
  return {
    defaults: {},
    daemon: {
      unixSocket: "/tmp/pi-threads.sock",
      worker: {
        minWorkers: 0,
        maxWorkers: 4,
        idleTtlMs: 300_000,
      },
      tcp: {
        enabled: false,
        bind: "127.0.0.1",
        port: 8765,
        allowedOrigins: [],
      },
    },
    servers: {
      local: {
        endpoint: "unix:///tmp/pi-threads.sock",
      },
    },
  };
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function loadConfig(path?: string): PiThreadsConfig {
  const configPath = path ? resolve(path) : defaultConfigPath();
  if (!existsSync(configPath)) {
    return defaultConfig();
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<PiThreadsConfig>;
  return validateConfig(mergeConfig(defaultConfig(), raw), configPath);
}

export function resolveEndpoint(options: {
  config: PiThreadsConfig;
  connect?: string;
  server?: string;
}): string {
  if (options.connect) {
    return options.connect;
  }
  const alias = options.server ?? "local";
  return options.config.servers[alias]?.endpoint ?? options.config.daemon.unixSocket;
}

export function resolveClientConfig(options: {
  config: PiThreadsConfig;
  connect?: string;
  server?: string;
  authToken?: string;
  authTokenEnv?: string;
  tlsCa?: string;
}): {
  endpoint: string;
  authToken?: string;
  authTokenEnv?: string;
  tlsCa?: string;
} {
  const alias = options.server ?? "local";
  const server = options.connect ? undefined : options.config.servers[alias];
  return {
    endpoint: options.connect ?? server?.endpoint ?? options.config.daemon.unixSocket,
    authToken: options.authToken ?? server?.authToken,
    authTokenEnv: options.authTokenEnv ?? server?.authTokenEnv,
    tlsCa: options.tlsCa ?? server?.tlsCa,
  };
}

export function serverNameCandidates(path?: string): string[] {
  return Object.keys(loadConfig(path).servers);
}

export function ensureParentDir(path: string): string {
  return dirname(resolve(path));
}

function mergeConfig(base: PiThreadsConfig, override: Partial<PiThreadsConfig>): PiThreadsConfig {
  return {
    defaults: { ...base.defaults, ...override.defaults },
    daemon: {
      ...base.daemon,
      ...override.daemon,
      worker: { ...base.daemon.worker, ...override.daemon?.worker },
      tcp: { ...base.daemon.tcp, ...override.daemon?.tcp },
    },
    servers: { ...base.servers, ...override.servers },
  };
}

function validateConfig(config: PiThreadsConfig, source: string): PiThreadsConfig {
  if (config.daemon.worker.maxWorkers < 1) {
    throw new Error(`${source}: daemon.worker.maxWorkers must be at least 1`);
  }
  if (config.daemon.worker.minWorkers < 0) {
    throw new Error(`${source}: daemon.worker.minWorkers must be non-negative`);
  }
  if (config.daemon.worker.minWorkers > config.daemon.worker.maxWorkers) {
    throw new Error(`${source}: daemon.worker.minWorkers cannot exceed maxWorkers`);
  }
  if (config.daemon.worker.idleTtlMs < 0) {
    throw new Error(`${source}: daemon.worker.idleTtlMs must be non-negative`);
  }
  if (
    config.defaults.thinking &&
    !THINKING_LEVELS.includes(config.defaults.thinking as (typeof THINKING_LEVELS)[number])
  ) {
    throw new Error(`${source}: defaults.thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return config;
}
