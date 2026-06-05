import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import type { PiThreadsService } from "../service/pi-threads-service.ts";
import { JsonRpcConnection } from "./json-rpc-router.ts";

export interface RunningTransport {
  name: string;
  close: () => Promise<void>;
}

export async function startUnixSocketServer(options: {
  path: string;
  service: PiThreadsService;
  onShutdown?: () => void | Promise<void>;
}): Promise<RunningTransport> {
  mkdirSync(dirname(options.path), { recursive: true });
  if (existsSync(options.path)) {
    unlinkSync(options.path);
  }
  const server = net.createServer((socket) => {
    new JsonRpcConnection({
      service: options.service,
      stream: socket,
      onShutdown: options.onShutdown,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    name: `unix://${options.path}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(options.path)) {
        unlinkSync(options.path);
      }
    },
  };
}
