import http from "node:http";
import https from "node:https";
import { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { assertBearerToken, assertOriginAllowed, type AuthConfig } from "../security/auth.ts";
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
  const tlsOptions = loadTlsOptions(options.tls);
  const server = tlsOptions ? https.createServer(tlsOptions) : http.createServer();
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    name: `${tlsOptions ? "wss" : "ws"}://${options.bind}:${options.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
      this.push(Buffer.isBuffer(data) ? data : Buffer.from(data.toString()));
    });
    socket.on("close", () => this.push(null));
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
}
