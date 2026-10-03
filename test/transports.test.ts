import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { defaultConfig } from "../src/config.ts";
import { startDaemon } from "../src/daemon.ts";
import { PiThreadsService } from "../src/service/pi-threads-service.ts";
import { startUnixSocketServer, type RunningTransport } from "../src/transport/unix.ts";
import { startNetworkServer } from "../src/transport/http.ts";

describe("daemon transports", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
    vi.restoreAllMocks();
  });

  function socketPath(): string {
    const root = mkdtempSync(join(tmpdir(), "pi-threads-transport-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return join(root, "daemon.sock");
  }

  function track(transport: RunningTransport): RunningTransport {
    cleanups.push(() => transport.close());
    return transport;
  }

  function service(): PiThreadsService {
    return {
      dispatch: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => "subscription-1"),
      unsubscribe: vi.fn(() => true),
    } as unknown as PiThreadsService;
  }

  async function connect(path: string, allowHalfOpen = false): Promise<net.Socket> {
    const socket = net.createConnection({ path, allowHalfOpen });
    cleanups.push(() => {
      socket.destroy();
    });
    await once(socket, "connect");
    return socket;
  }

  async function websocket(transport: RunningTransport): Promise<WebSocket> {
    const socket = new WebSocket(transport.names[1]!);
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    return socket;
  }

  it("refuses to replace regular files at the configured socket path", async () => {
    const path = socketPath();
    writeFileSync(path, "keep this file");
    await expect(startUnixSocketServer({ path, service: service() })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(readFileSync(path, "utf8")).toBe("keep this file");
  });

  it("refuses to replace another running daemon's socket", async () => {
    const path = socketPath();
    track(await startUnixSocketServer({ path, service: service() }));
    await expect(startUnixSocketServer({ path, service: service() })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    const socket = await connect(path);
    const response = once(socket, "data");
    socket.write('{"jsonrpc":"2.0","id":"1","method":"server/status"}\n');
    expect(JSON.parse(String((await response)[0])).result).toEqual({ ok: true });
  });

  it("recovers a socket left behind by a crashed process", async () => {
    const path = socketPath();
    const child = spawn(process.execPath, [
      "-e",
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))',
      path,
    ]);
    cleanups.push(() => {
      child.kill("SIGKILL");
    });
    await once(child.stdout!, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(existsSync(path)).toBe(true);
    track(await startUnixSocketServer({ path, service: service() }));
    await connect(path);
  });

  it("closes Unix clients that leave their half of the connection open", async () => {
    const path = socketPath();
    const transport = track(await startUnixSocketServer({ path, service: service() }));
    await connect(path, true);
    await transport.close();
    expect(existsSync(path)).toBe(false);
  });

  it("flushes a shutdown response before closing the requesting connection", async () => {
    const path = socketPath();
    const transport = track(
      await startUnixSocketServer({
        path,
        service: service(),
        onShutdown: () => transport.close(),
      }),
    );
    const socket = await connect(path);
    const response = once(socket, "data");
    socket.write('{"jsonrpc":"2.0","id":"shutdown","method":"server/shutdown"}\n');
    expect(JSON.parse(String((await response)[0]))).toMatchObject({
      id: "shutdown",
      result: { ok: true },
    });
  });

  it("accepts whole WebSocket JSON messages and releases subscriptions on disconnect", async () => {
    const target = service();
    const transport = track(
      await startNetworkServer({
        bind: "127.0.0.1",
        port: 0,
        auth: {},
        service: target,
      }),
    );
    const socket = await websocket(transport);
    const subscribed = once(socket, "message");
    socket.send('{"jsonrpc":"2.0","id":"1","method":"subscribe/all"}');
    expect(JSON.parse(String((await subscribed)[0])).result.subscriptionId).toBe("subscription-1");
    const response = once(socket, "message");
    socket.send('{"jsonrpc":"2.0","id":"2","method":"server/status"}\n');
    expect(JSON.parse(String((await response)[0])).id).toBe("2");
    socket.close();
    await vi.waitFor(() => expect(target.unsubscribe).toHaveBeenCalledWith("subscription-1"));
  });

  it("closes WebSocket clients and idle HTTP connections during shutdown", async () => {
    const transport = track(
      await startNetworkServer({
        bind: "127.0.0.1",
        port: 0,
        auth: {},
        service: service(),
      }),
    );
    const socket = await websocket(transport);
    const endpoint = new URL(transport.names[0]!);
    const idle = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    cleanups.push(() => {
      idle.destroy();
    });
    await once(idle, "connect");
    await transport.close();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("enforces bearer credentials and origins for WebSocket upgrades on the shared listener", async () => {
    const transport = track(
      await startNetworkServer({
        bind: "127.0.0.1",
        port: 0,
        auth: { token: "secret", allowedOrigins: ["https://app.example"] },
        service: service(),
      }),
    );
    for (const headers of [
      { Origin: "https://app.example" },
      { Origin: "https://app.example", Authorization: "Bearer wrong" },
      { Origin: "https://evil.example", Authorization: "Bearer secret" },
    ]) {
      const socket = new WebSocket(transport.names[1]!, { headers });
      cleanups.push(() => socket.terminate());
      await expect(once(socket, "open")).rejects.toThrow("401");
    }
    const socket = new WebSocket(transport.names[1]!, {
      headers: { Origin: "https://app.example", Authorization: "Bearer secret" },
    });
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send('{"jsonrpc":"2.0","id":"auth","method":"server/status"}');
    expect(JSON.parse(String((await response)[0])).result).toEqual({ ok: true });
  });

  it("cleans up an already-open Unix transport when later daemon startup fails", async () => {
    const occupied = net.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const address = occupied.address() as net.AddressInfo;
    const config = defaultConfig();
    config.daemon.unixSocket = socketPath();
    config.daemon.tcp.enabled = true;
    config.daemon.tcp.port = address.port;
    const shutdown = vi.spyOn(PiThreadsService.prototype, "shutdown");
    await expect(startDaemon(config)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(shutdown).toHaveBeenCalled();
    expect(existsSync(config.daemon.unixSocket)).toBe(false);
    track(await startUnixSocketServer({ path: config.daemon.unixSocket, service: service() }));
  });
});
