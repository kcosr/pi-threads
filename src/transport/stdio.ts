import { Duplex } from "node:stream";
import type { PiThreadsService } from "../service/pi-threads-service.ts";
import { JsonRpcConnection } from "./json-rpc-router.ts";

export function startStdioServer(options: {
  service: PiThreadsService;
  onShutdown?: () => void | Promise<void>;
}): void {
  new JsonRpcConnection({
    service: options.service,
    stream: new StdioDuplex(),
    onShutdown: options.onShutdown,
  });
}

class StdioDuplex extends Duplex {
  constructor() {
    super();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => this.push(chunk));
    process.stdin.on("end", () => this.push(null));
  }

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    process.stdout.write(chunk, callback);
  }
}
