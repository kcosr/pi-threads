import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
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
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    new JsonRpcConnection({
      service: options.service,
      stream: socket,
      onShutdown: options.onShutdown,
    });
  });
  try {
    await listen(server, options.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const existing = lstatSync(options.path);
    if (!existing.isSocket() || !(await isStaleSocket(options.path))) throw error;
    const current = lstatSync(options.path);
    if (current.dev !== existing.dev || current.ino !== existing.ino) throw error;
    unlinkSync(options.path);
    await listen(server, options.path);
  }
  let closing: Promise<void> | undefined;
  return {
    name: `unix://${options.path}`,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, 1_000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const socket of sockets) socket.end();
      });
      return closing;
    },
  };
}

function listen(server: net.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isStaleSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const finish = (stale: boolean) => {
      socket.destroy();
      resolve(stale);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
  });
}
