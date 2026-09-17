/**
 * Minimal MCP client for driving the built server by hand:
 *
 *   npm run build && node scripts/call.ts jev_ask '{"state":"...","questions":{...}}'
 *
 * Pass "-" as the argument to read the JSON arguments from stdin.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [name, rawArgs] = process.argv.slice(2);
  if (name === undefined) throw new Error("usage: node scripts/call.ts <tool> '<json>'");

  const apiKey = process.env["TYPESAFE_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new Error("TYPESAFE_API_KEY is not set");

  const json = rawArgs === undefined || rawArgs === "-" ? await readStdin() : rawArgs;
  const client = new Client({ name: "jev-mcp-cli", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { TYPESAFE_API_KEY: apiKey, PATH: process.env["PATH"] ?? "" },
    }),
  );

  const result = await client.callTool({
    name,
    arguments: JSON.parse(json.trim() === "" ? "{}" : json) as Record<string, unknown>,
  });
  for (const part of result.content as { type: string; text?: string }[]) {
    console.log(part.text ?? part.type);
  }
  await client.close();
  if (result.isError === true) process.exitCode = 1;
}

await main();
