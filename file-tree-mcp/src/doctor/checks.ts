import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { promisify } from "node:util"
import { createIgnore, isIgnored } from "../lib/ignore.ts"
import { parseVersion, satisfies } from "./semver.ts"

const run = promisify(execFile)

export type Level = "ok" | "warn" | "fail" | "info"
export interface Finding {
  level: Level
  title: string
  detail?: string
  fix?: string
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** Run a fixed command (never via a shell) and return trimmed output, or undefined when it is missing/fails. */
async function out(cmd: string, args: string[], timeout = 4000): Promise<string | undefined> {
  try {
    const r = await run(cmd, args, { timeout, windowsHide: true })
    return `${r.stdout}${r.stderr}`.trim()
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- tools

interface Requirement {
  tool: string
  range: string
  source: string
}

/** What the project itself says it needs. */
export function requirements(root: string): Requirement[] {
  const reqs: Requirement[] = []
  const pkg = read(join(root, "package.json"))
  if (pkg) {
    try {
      const engines = JSON.parse(pkg).engines ?? {}
      for (const tool of Object.keys(engines)) reqs.push({ tool, range: String(engines[tool]), source: "package.json engines" })
    } catch {
      // unreadable package.json is reported elsewhere
    }
  }
  const nvm = (read(join(root, ".nvmrc")) ?? read(join(root, ".node-version")))?.trim()
  if (nvm && !reqs.some((r) => r.tool === "node") && /\d/.test(nvm)) reqs.push({ tool: "node", range: nvm.replace(/^v/, ""), source: ".nvmrc" })
  const py = (read(join(root, ".python-version")) ?? "").trim()
  if (py) reqs.push({ tool: "python", range: py, source: ".python-version" })
  const pyproject = read(join(root, "pyproject.toml"))?.match(/requires-python\s*=\s*"([^"]+)"/)
  if (pyproject) reqs.push({ tool: "python", range: pyproject[1]!, source: "pyproject.toml" })
  const gomod = read(join(root, "go.mod"))?.match(/^go\s+(\d+(?:\.\d+)*)/m)
  if (gomod) reqs.push({ tool: "go", range: `>=${gomod[1]}`, source: "go.mod" })
  const rust = read(join(root, "Cargo.toml"))?.match(/rust-version\s*=\s*"([^"]+)"/)
  if (rust) reqs.push({ tool: "rust", range: `>=${rust[1]}`, source: "Cargo.toml" })
  return reqs
}

const PROBES: Record<string, [string, string[]]> = {
  node: ["node", ["-v"]],
  npm: ["npm", ["-v"]],
  pnpm: ["pnpm", ["-v"]],
  yarn: ["yarn", ["-v"]],
  python: ["python3", ["--version"]],
  go: ["go", ["version"]],
  rust: ["rustc", ["--version"]],
  docker: ["docker", ["--version"]],
  git: ["git", ["--version"]],
}

export async function checkTools(root: string): Promise<Finding[]> {
  const findings: Finding[] = []
  const reqs = requirements(root)
  const need = new Set(reqs.map((r) => r.tool))
  if (existsSync(join(root, "Dockerfile")) || existsSync(join(root, "docker-compose.yml")) || existsSync(join(root, "compose.yaml"))) need.add("docker")
  const lock = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"].find((f) => existsSync(join(root, f)))
  if (lock) need.add(lock === "pnpm-lock.yaml" ? "pnpm" : lock === "yarn.lock" ? "yarn" : "npm")
  if (existsSync(join(root, ".git"))) need.add("git")

  for (const tool of need) {
    const probe = PROBES[tool]
    if (!probe) continue
    const raw = await out(probe[0], probe[1])
    if (raw === undefined) {
      findings.push({ level: "fail", title: `${tool} is not installed`, fix: `Install ${tool} and make sure it is on PATH.` })
      continue
    }
    const version = parseVersion(raw)?.join(".") ?? raw
    for (const req of reqs.filter((r) => r.tool === tool)) {
      const ok = satisfies(version, req.range)
      if (ok === false) {
        findings.push({
          level: "fail",
          title: `${tool} ${version} does not satisfy "${req.range}"`,
          detail: `required by ${req.source}`,
          fix: tool === "node" ? "Switch versions (nvm use / fnm use / volta) to one matching the requirement." : `Install a ${tool} version matching ${req.range}.`,
        })
      } else if (ok === undefined) {
        findings.push({ level: "info", title: `${tool} ${version}`, detail: `could not compare with "${req.range}" (${req.source})` })
      } else findings.push({ level: "ok", title: `${tool} ${version}`, detail: `satisfies "${req.range}" (${req.source})` })
    }
    if (!reqs.some((r) => r.tool === tool)) findings.push({ level: "ok", title: `${tool} ${version}` })
  }

  // The project says which package manager it wants; using another one breaks lockfiles.
  const pm = (() => {
    try {
      return JSON.parse(read(join(root, "package.json")) ?? "{}").packageManager as string | undefined
    } catch {
      return undefined
    }
  })()
  if (pm) {
    const name = pm.split("@")[0]!
    if (lock && !lock.startsWith(name === "yarn" ? "yarn" : name === "pnpm" ? "pnpm" : "package")) {
      findings.push({ level: "warn", title: `packageManager is ${pm} but the lockfile is ${lock}`, fix: `Use ${name} (or fix the mismatch).` })
    }
  }
  return findings
}

// ---------------------------------------------------------------- deps

export function checkDeps(root: string): Finding[] {
  const pkgText = read(join(root, "package.json"))
  if (!pkgText) return []
  let pkg: any
  try {
    pkg = JSON.parse(pkgText)
  } catch {
    return [{ level: "fail", title: "package.json is not valid JSON" }]
  }
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  if (names.length === 0) return []
  const modules = join(root, "node_modules")
  if (!existsSync(modules)) return [{ level: "fail", title: "node_modules is missing", fix: "Run your package manager's install." }]
  const missing = names.filter((n) => !existsSync(join(modules, n)))
  if (missing.length) {
    return [{ level: "fail", title: `${missing.length} dependenc${missing.length === 1 ? "y is" : "ies are"} not installed`, detail: missing.slice(0, 8).join(", "), fix: "Run your package manager's install." }]
  }
  const lock = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"].map((f) => join(root, f)).find(existsSync)
  if (lock && statSync(lock).mtimeMs > statSync(modules).mtimeMs + 1000) {
    return [{ level: "warn", title: "lockfile is newer than node_modules", detail: "dependencies may be out of date", fix: "Re-run install." }]
  }
  return [{ level: "ok", title: `${names.length} dependencies installed` }]
}

// ---------------------------------------------------------------- ports

const COMMON_PORTS = [3000, 5173, 8000, 8080, 5432, 6379, 27017, 3306]

export function projectPorts(root: string): number[] {
  const found = new Set<number>()
  const add = (n: number) => Number.isInteger(n) && n > 0 && n < 65536 && found.add(n)
  for (const file of [".env", ".env.example", ".env.local"]) {
    for (const m of read(join(root, file))?.matchAll(/^\s*(?:\w*PORT)\s*=\s*(\d+)/gim) ?? []) add(Number(m[1]))
  }
  for (const file of ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"]) {
    for (const m of read(join(root, file))?.matchAll(/["']?(\d{2,5}):\d{2,5}["']?/g) ?? []) add(Number(m[1]))
  }
  for (const m of read(join(root, "package.json"))?.matchAll(/(?:--port|-p|PORT=)\s*=?\s*(\d{2,5})/g) ?? []) add(Number(m[1]))
  return found.size ? [...found] : COMMON_PORTS
}

function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE"))
    server.once("listening", () => server.close(() => resolve(false)))
    server.listen(port, "127.0.0.1")
  })
}

async function who(port: number): Promise<string | undefined> {
  const raw = await out("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]) // macOS/Linux; absent on Windows
  if (!raw) return undefined
  const pid = /^p(\d+)/m.exec(raw)?.[1]
  const cmd = /^c(.+)$/m.exec(raw)?.[1]
  return pid ? `${cmd ?? "process"} (pid ${pid})` : undefined
}

export async function checkPorts(ports: number[]): Promise<Finding[]> {
  const valid = [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))].slice(0, 30)
  const results = await Promise.all(valid.map(async (p) => ({ p, busy: await inUse(p) })))
  const findings: Finding[] = []
  for (const { p, busy } of results) {
    if (!busy) continue
    const owner = await who(p)
    findings.push({
      level: "warn",
      title: `port ${p} is in use`,
      detail: owner ? `held by ${owner}` : undefined,
      fix: owner ? `Stop it, or run this project on another port. (If that process IS this project, it is already running.)` : "Free the port or use another one.",
    })
  }
  const free = results.filter((r) => !r.busy).map((r) => r.p)
  if (free.length) findings.push({ level: "ok", title: `ports free: ${free.join(", ")}` })
  return findings
}

// ---------------------------------------------------------------- env vars

const IGNORED_VARS = new Set(["NODE_ENV", "PATH", "HOME", "PWD", "CI", "USER", "SHELL", "TERM", "LANG", "TZ", "DEBUG", "PORT_FALLBACK"])
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rb|php|vue|svelte)$/
const VAR_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ(?:\.get)?[[(]\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"\)/g,
]

/** Variable NAMES in a dotenv file. Values are never read into results — they are often secrets. */
function dotenvNames(path: string): Set<string> | undefined {
  const text = read(path)
  if (text === undefined) return undefined
  const names = new Set<string>()
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (m) names.add(m[1]!)
  }
  return names
}

function usedVars(root: string): Map<string, string> {
  const ignore = createIgnore()
  const used = new Map<string, string>() // name -> first file using it
  let files = 0
  const walk = (rel: string): void => {
    let entries
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files >= 3000) return
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (isIgnored(path, ignore)) continue
      if (entry.isDirectory()) walk(path)
      else if (CODE_EXT.test(entry.name)) {
        files += 1
        const full = join(root, path)
        try {
          if (statSync(full).size > 200_000) continue
        } catch {
          continue
        }
        const text = read(full) ?? ""
        for (const pattern of VAR_PATTERNS) {
          for (const m of text.matchAll(pattern)) if (!used.has(m[1]!)) used.set(m[1]!, path)
        }
      }
    }
  }
  walk("")
  return used
}

export function checkEnv(root: string): Finding[] {
  const findings: Finding[] = []
  const env = dotenvNames(join(root, ".env"))
  const example = dotenvNames(join(root, ".env.example")) ?? dotenvNames(join(root, ".env.sample"))

  if (example && !env) {
    findings.push({ level: "fail", title: ".env is missing", detail: `.env.example lists ${example.size} variables`, fix: "Copy .env.example to .env and fill in the values." })
  } else if (example && env) {
    const missing = [...example].filter((n) => !env.has(n) && !(n in process.env))
    if (missing.length) {
      findings.push({ level: "fail", title: `${missing.length} variable${missing.length === 1 ? "" : "s"} in .env.example ${missing.length === 1 ? "is" : "are"} not set`, detail: missing.slice(0, 12).join(", "), fix: "Add them to .env (names only shown here; values are never read)." })
    }
  }

  const defined = new Set<string>([...(env ?? []), ...(example ?? []), ...Object.keys(process.env)])
  for (const file of [".env.local", ".env.development"]) for (const n of dotenvNames(join(root, file)) ?? []) defined.add(n)
  const unset = [...usedVars(root)].filter(([name]) => !defined.has(name) && !IGNORED_VARS.has(name))
  if (unset.length) {
    findings.push({
      level: "warn",
      title: `${unset.length} variable${unset.length === 1 ? " is" : "s are"} read in code but not defined anywhere`,
      detail: unset.slice(0, 10).map(([n, f]) => `${n} (${f})`).join(", "),
      fix: "Define them in .env, or ignore them if they have defaults in code.",
    })
  }
  if (findings.length === 0 && (env || example)) findings.push({ level: "ok", title: "environment variables look complete" })
  return findings
}

// ---------------------------------------------------------------- docker

export async function checkDocker(root: string): Promise<Finding[]> {
  const uses = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"].some((f) => existsSync(join(root, f)))
  if (!uses) return []
  const info = await out("docker", ["info", "--format", "{{.ServerVersion}}"], 6000)
  if (info === undefined) return [] // "docker not installed" is already reported by checkTools
  if (/cannot connect|is the docker daemon running/i.test(info)) {
    return [{ level: "fail", title: "Docker is installed but the daemon is not running", fix: "Start Docker Desktop (or `sudo systemctl start docker`)." }]
  }
  return [{ level: "ok", title: `Docker daemon running (${info})` }]
}

// ---------------------------------------------------------------- error explainer

const PATTERNS: Array<{ re: RegExp; cause: string; next: string }> = [
  { re: /EADDRINUSE.*?(\d{2,5})/i, cause: "A port is already taken by another process.", next: "check_ports with that port" },
  { re: /Cannot find module|MODULE_NOT_FOUND/i, cause: "A dependency is missing or not installed.", next: "check_deps" },
  { re: /Unsupported engine|engine "node"|requires Node|SyntaxError: Unexpected token '\?/i, cause: "The node version doesn't match what the project (or a dependency) needs.", next: "check_tools" },
  { re: /ECONNREFUSED.*?(5432|3306|6379|27017)/i, cause: "A database/cache the app needs is not running.", next: "check_ports (it should be IN USE) and check_docker" },
  { re: /ECONNREFUSED/i, cause: "Something the app connects to isn't listening.", next: "check_ports and check_docker" },
  { re: /(undefined|missing|required).{0,40}(env|environment|variable)|is not set/i, cause: "A required environment variable is missing.", next: "check_env" },
  { re: /Cannot connect to the Docker daemon/i, cause: "The Docker daemon isn't running.", next: "check_docker" },
  { re: /command not found|ENOENT.*spawn|is not recognized as an internal/i, cause: "A required program isn't installed or isn't on PATH.", next: "check_tools" },
  { re: /EACCES|permission denied/i, cause: "A permissions problem (file, port <1024, or global install).", next: "inspect the path in the message; avoid sudo for npm installs" },
  { re: /ERESOLVE|peer dep/i, cause: "Conflicting package versions.", next: "check_deps; try the install with --legacy-peer-deps if the conflict is only a peer range" },
]

export function explain(errorText: string): string {
  const hits = PATTERNS.filter((p) => p.re.test(errorText))
  if (hits.length === 0) return "No known pattern matched. Run `diagnose` for a full health check."
  return hits.map((h) => `• ${h.cause}\n  next: ${h.next}`).join("\n")
}

// ---------------------------------------------------------------- report

const ICON: Record<Level, string> = { ok: "✔", warn: "⚠", fail: "✖", info: "·" }

export function format(title: string, findings: Finding[]): string {
  if (findings.length === 0) return `${title}\n  nothing to check here.`
  const lines = [title]
  for (const f of findings) {
    lines.push(`  ${ICON[f.level]} ${f.title}${f.detail ? ` — ${f.detail}` : ""}`)
    if (f.fix && f.level !== "ok") lines.push(`      fix: ${f.fix}`)
  }
  return lines.join("\n")
}

export async function diagnose(root: string): Promise<{ text: string; failures: number; warnings: number }> {
  const sections: Array<[string, Finding[]]> = [
    ["Tools", await checkTools(root)],
    ["Dependencies", checkDeps(root)],
    ["Environment variables", checkEnv(root)],
    ["Ports", await checkPorts(projectPorts(root))],
    ["Docker", await checkDocker(root)],
  ]
  const all = sections.flatMap(([, f]) => f)
  const failures = all.filter((f) => f.level === "fail").length
  const warnings = all.filter((f) => f.level === "warn").length
  const head = failures + warnings === 0 ? "✔ No problems found." : `${failures} problem(s), ${warnings} warning(s).`
  return { text: [head, ...sections.filter(([, f]) => f.length).map(([t, f]) => format(t, f))].join("\n\n"), failures, warnings }
}
