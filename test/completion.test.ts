import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/commands.ts";

const originalWrite = process.stdout.write;

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe("CLI completion", () => {
  it("completes root commands", async () => {
    const output = await captureStdout(() => runCli(["node", "pi-threads", "__complete", "--", "s"]));

    expect(output.split("\n")).toContain("search");
    expect(output.split("\n")).toContain("send");
    expect(output.split("\n")).toContain("servers");
  });

  it("completes command options and option choices", async () => {
    const listOptions = await captureStdout(() =>
      runCli(["node", "pi-threads", "__complete", "--", "--s", "list"]),
    );
    expect(listOptions.split("\n")).toContain("--since");
    expect(listOptions.split("\n")).toContain("--sort");

    const sortChoices = await captureStdout(() =>
      runCli(["node", "pi-threads", "__complete", "--", "", "list", "--sort"]),
    );
    expect(sortChoices.split("\n")).toContain("updated");
    expect(sortChoices.split("\n")).toContain("created");
  });
});

async function captureStdout(callback: () => Promise<void>): Promise<string> {
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  await callback();
  return output;
}
