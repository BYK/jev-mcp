/**
 * End-to-end check: drives the built server over stdio as a real MCP client
 * would, against the live TypeSafe API. Requires TYPESAFE_API_KEY.
 *
 *   npm run build && node scripts/smoke.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const URGENT = {
  type: "noul" as const,
  instructions: "Does this support ticket describe an urgent, revenue- or security-impacting problem?",
};

async function main(): Promise<void> {
  const apiKey = process.env["TYPESAFE_API_KEY"];
  if (apiKey === undefined || apiKey === "") throw new Error("TYPESAFE_API_KEY is not set");

  const client = new Client({ name: "jev-mcp-smoke", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { TYPESAFE_API_KEY: apiKey, PATH: process.env["PATH"] ?? "" },
    }),
  );

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((tool) => tool.name).join(", "), "\n");

  for (const call of [
    {
      name: "jev_ask",
      arguments: {
        state: "Production checkout is down since the 4.2 upgrade, we are losing orders.",
        questions: {
          urgent: URGENT,
          severity: { type: "score", instructions: "How severe is this?", criteria: ["trivial", "minor", "major", "critical"] },
          area: {
            type: "choice",
            instructions: "Which team should own this ticket?",
            criteria: { billing: "payments and invoicing", platform: "availability and errors", docs: "documentation" },
          },
        },
      },
    },
    {
      name: "jev_map",
      arguments: {
        dataset_path: "examples/support-tickets.jsonl",
        questions: { urgent: URGENT },
        sort_by: "urgent",
        max_rows: 5,
      },
    },
    {
      name: "jev_eval",
      arguments: {
        dataset_path: "examples/support-tickets.jsonl",
        variants: {
          plain: { type: "noul", instructions: "Is this ticket urgent?" },
          detailed: URGENT,
        },
        max_errors: 3,
      },
    },
  ]) {
    console.log(`=== ${call.name} ===`);
    const result = await client.callTool(call);
    for (const part of result.content as { type: string; text?: string }[]) {
      console.log(part.text ?? part.type);
    }
    if (result.isError === true) throw new Error(`${call.name} returned an error`);
    console.log();
  }

  await client.close();
}

await main();
