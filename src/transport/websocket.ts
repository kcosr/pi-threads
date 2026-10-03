import type http from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { assertBearerToken, assertOriginAllowed, type AuthConfig } from "../security/auth.ts";
import type { PiThreadsService } from "../service/pi-threads-service.ts";
import { JsonRpcConnection } from "./json-rpc-router.ts";

export function attachWebSocketServer(
  server: http.Server,
  options: {
    auth: AuthConfig;
    service: PiThreadsService;
    onShutdown?: () => void | Promise<void>;
  },
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: "/",
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
  return wss;
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
