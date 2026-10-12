// Minimal semver range check for the forms engines/.nvmrc actually use. Returns undefined when the range isn't understood.
type V = [number, number, number]

export function parseVersion(text: string): V | undefined {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text)
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined
}

const cmp = (a: V, b: V): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function satisfiesOne(version: V, comp: string): boolean | undefined {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(comp)
  if (!m) return undefined
  const op = m[1] ?? ""
  const wild = (s?: string) => s === undefined || /[xX*]/.test(s)
  const base: V = [Number(m[2]) || 0, Number(m[3]) || 0, Number(m[4]) || 0]
  if (/[xX*]/.test(m[2]!)) return true
  const c = cmp(version, base)
  switch (op) {
    case ">=": return c >= 0
    case ">": return c > 0
    case "<=": return c <= 0
    case "<": return c < 0
    case "^": return c >= 0 && (base[0] > 0 ? version[0] === base[0] : version[1] === base[1])
    case "~": return c >= 0 && version[0] === base[0] && version[1] === base[1]
    default: // bare "20", "20.x", "20.1", "20.1.2": match the given precision
      return version[0] === base[0] && (wild(m[3]) || version[1] === base[1]) && (wild(m[4]) || version[2] === base[2])
  }
}

export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version)
  if (!v) return undefined
  const alternatives = range.split("||").map((part) => part.trim())
  let understood = false
  for (const alt of alternatives) {
    const results = alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean).map((c) => satisfiesOne(v, c))
    if (results.every((r) => r !== undefined)) understood = true
    if (results.length > 0 && results.every((r) => r === true)) return true
  }
  return understood ? false : undefined
}
