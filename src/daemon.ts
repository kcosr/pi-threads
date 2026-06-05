import type { PiThreadsConfig } from "./config.ts";
import { PiThreadsService } from "./service/pi-threads-service.ts";
import { startStdioServer } from "./transport/stdio.ts";
import { startUnixSocketServer, type RunningTransport } from "./transport/unix.ts";
import { startWebSocketServer } from "./transport/websocket.ts";

export interface DaemonRuntime {
  service: PiThreadsService;
  transports: RunningTransport[];
  stop: () => Promise<void>;
}

export async function startDaemon(
  config: PiThreadsConfig,
  options?: { stdio?: boolean },
): Promise<DaemonRuntime> {
  const service = new PiThreadsService(config);
  await service.start();
  const transports: RunningTransport[] = [];
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await Promise.all(transports.map((transport) => transport.close()));
    await service.shutdown();
  };
  if (options?.stdio) {
    startStdioServer({ service, onShutdown: stop });
    transports.push({ name: "stdio", close: async () => undefined });
  } else {
    transports.push(
      await startUnixSocketServer({
        path: config.daemon.unixSocket,
        service,
        onShutdown: stop,
      }),
    );
  }
  if (config.daemon.tcp.enabled) {
    transports.push(
      await startWebSocketServer({
        bind: config.daemon.tcp.bind,
        port: config.daemon.tcp.port,
        tls: config.daemon.tcp.tls,
        auth: {
          token: config.daemon.tcp.authToken,
          tokenEnv: config.daemon.tcp.authTokenEnv,
          allowedOrigins: config.daemon.tcp.allowedOrigins,
        },
        service,
        onShutdown: stop,
      }),
    );
  }
  service.setTransports(transports.map((transport) => transport.name));
  return { service, transports, stop };
}
