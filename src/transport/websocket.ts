import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  assertAuthConfiguredForBind,
  assertBearerToken,
  assertOriginAllowed,
  type AuthConfig,
} from "../security/auth.ts";
import { assertTlsAllowedForBind, loadTlsOptions, type TlsConfig } from "../security/tls.ts";
import type { PiThreadsService } from "../service/pi-threads-service.ts";
import { JsonRpcConnection } from "./json-rpc-router.ts";
import type { RunningTransport } from "./unix.ts";

export async function startWebSocketServer(options: {
  bind: string;
  port: number;
  tls?: TlsConfig;
  auth: AuthConfig;
  service: PiThreadsService;
  onShutdown?: () => void | Promise<void>;
}): Promise<RunningTransport> {
  assertTlsAllowedForBind(options.bind, options.tls);
  assertAuthConfiguredForBind(options.bind, options.auth);
  const tlsOptions = loadTlsOptions(options.tls);
  const server = tlsOptions ? https.createServer(tlsOptions) : http.createServer();
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const wss = new WebSocketServer({
    server,
    verifyClient(info, done) {
      try {
        assertBearerToken(options.auth, info.req.headers.authorization);
        assertOriginAllowed(options.auth.allowedOrigins, info.origin);
        done(true);
      } catch {
        done(false, 401, "Unauthorized");
      }
    },
  });
  wss.on("connection", (socket) => {
    new JsonRpcConnection({
      service: options.service,
      stream: WebSocketDuplex.wrap(socket),
      onShutdown: options.onShutdown,
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      wss.once("error", reject);
      server.listen(options.port, options.bind, () => {
        server.off("error", reject);
        wss.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    wss.close();
    throw error;
  }
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port;
  let closing: Promise<void> | undefined;
  return {
    name: `${tlsOptions ? "wss" : "ws"}://${options.bind}:${port}`,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          for (const socket of wss.clients) socket.terminate();
          for (const connection of connections) connection.destroy();
        }, 1_000);
        const websocketClosed = new Promise<void>((done) => wss.close(() => done()));
        const httpClosed = new Promise<void>((done) => server.close(() => done()));
        for (const socket of wss.clients) socket.close(1001, "Daemon stopping");
        void Promise.all([websocketClosed, httpClosed]).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return closing;
    },
  };
}

class WebSocketDuplex extends Duplex {
  static wrap(socket: WebSocket): WebSocketDuplex {
    return new WebSocketDuplex(socket);
  }

  private constructor(private readonly socket: WebSocket) {
    super();
    socket.on("message", (data) => {
      const message = (
        Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      ).toString("utf8");
      this.push(message.endsWith("\n") ? message : `${message}\n`);
    });
    socket.on("close", () => this.destroy());
    socket.on("error", (error) => this.destroy(error));
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.send(chunk.toString("utf8"), callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    this.socket.close();
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.terminate();
    callback(error);
  }
}
