// env-doctor MCP server: tells the AI (or you, with `doctor --report`) why a project won't run.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { resolve } from "node:path"
import { z } from "zod"
import { checkDeps, checkDocker, checkEnv, checkPorts, checkTools, diagnose, explain, format, projectPorts } from "./checks.ts"

const root = (): string => resolve(process.env.DOCTOR_ROOT ?? process.cwd())
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

/** `doctor --report`: the same health check as plain text for a human, no AI involved. */
export async function report(): Promise<number> {
  const result = await diagnose(root())
  console.log(result.text)
  return result.failures > 0 ? 1 : 0
}

export async function serve(): Promise<void> {
  const server = new McpServer({ name: "env-doctor", version: "0.1.0" })

  server.registerTool(
    "diagnose",
    {
      description:
        "Full health check of this project's environment: required tool versions vs what's installed, missing dependencies, missing/undefined env vars (names only, never values), busy ports, Docker. Call this FIRST when a build/start fails or 'works on my machine' problems appear, before running many shell commands.",
      inputSchema: {},
    },
    async () => text((await diagnose(root())).text),
  )

  server.registerTool(
    "explain_error",
    {
      description: "Paste an error message; get the likely cause and which check to run next.",
      inputSchema: { error: z.string().min(3).max(8000) },
    },
    async ({ error }) => text(explain(error)),
  )

  server.registerTool(
    "check_tools",
    { description: "Compare installed node/python/go/rust/docker/package-manager versions with what the project requires.", inputSchema: {} },
    async () => text(format("Tools", await checkTools(root()))),
  )

  server.registerTool(
    "check_deps",
    { description: "Are the project's node dependencies installed and up to date with the lockfile?", inputSchema: {} },
    async () => text(format("Dependencies", checkDeps(root()))),
  )

  server.registerTool(
    "check_env",
    {
      description: "Compare .env with .env.example and with variables read in code. Reports variable NAMES only; values are never read or shown.",
      inputSchema: {},
    },
    async () => text(format("Environment variables", checkEnv(root()))),
  )

  server.registerTool(
    "check_ports",
    {
      description: "Which ports are in use and by what process. Defaults to the ports the project mentions (.env, compose, scripts).",
      inputSchema: { ports: z.array(z.number().int().min(1).max(65535)).max(30).optional() },
    },
    async ({ ports }) => text(format("Ports", await checkPorts(ports ?? projectPorts(root())))),
  )

  server.registerTool(
    "check_docker",
    { description: "If the project uses Docker: is the daemon running?", inputSchema: {} },
    async () => text(format("Docker", await checkDocker(root()))),
  )

  await server.connect(new StdioServerTransport())
}
