import type { PiThreadsConfig } from "./config.ts";
import { PiThreadsService } from "./service/pi-threads-service.ts";
import { startStdioServer } from "./transport/stdio.ts";
import { startUnixSocketServer, type RunningTransport } from "./transport/unix.ts";
import { startNetworkServer } from "./transport/http.ts";

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
  const transports: RunningTransport[] = [];
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      const results = await Promise.allSettled(transports.map((transport) => transport.close()));
      await service.shutdown();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return stopping;
  };
  try {
    await service.start();
    if (options?.stdio) {
      transports.push(startStdioServer({ service, onShutdown: stop }));
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
        await startNetworkServer({
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
  } catch (error) {
    await stop();
    throw error;
  }
  service.setTransports(transports.flatMap((transport) => transport.names));
  return { service, transports, stop };
}
