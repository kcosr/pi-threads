import { Duplex } from "node:stream";
import type { PiThreadsService } from "../service/pi-threads-service.ts";
import { JsonRpcConnection } from "./json-rpc-router.ts";
import type { RunningTransport } from "./unix.ts";

export function startStdioServer(options: {
  service: PiThreadsService;
  onShutdown?: () => void | Promise<void>;
}): RunningTransport {
  const stream = new StdioDuplex();
  const connection = new JsonRpcConnection({
    service: options.service,
    stream,
    onShutdown: options.onShutdown,
  });
  stream.once("end", () => void options.onShutdown?.());
  return {
    name: "stdio",
    close: async () => {
      connection.close();
      stream.destroy();
    },
  };
}

class StdioDuplex extends Duplex {
  private readonly onData = (chunk: string) => this.push(chunk);
  private readonly onEnd = () => this.push(null);

  constructor() {
    super();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onEnd);
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    process.stdout.write(chunk, callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    process.stdin.off("data", this.onData);
    process.stdin.off("end", this.onEnd);
    process.stdin.pause();
    callback(error);
  }
}
