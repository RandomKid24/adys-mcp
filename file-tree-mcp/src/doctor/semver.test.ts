// Run: node src/doctor/semver.test.ts
import assert from "node:assert/strict"
import { satisfies } from "./semver.ts"

assert.equal(satisfies("20.11.0", ">=18"), true)
assert.equal(satisfies("16.20.0", ">=18"), false)
assert.equal(satisfies("20.11.0", "^20.0.0"), true)
assert.equal(satisfies("21.0.0", "^20.0.0"), false)
assert.equal(satisfies("20.11.0", "20"), true)
assert.equal(satisfies("20.11.0", "20.x"), true)
assert.equal(satisfies("18.0.0", "18 || 20"), true)
assert.equal(satisfies("22.1.0", ">=18 <21"), false)
assert.equal(satisfies("1.2.3", "~1.2.0"), true)
assert.equal(satisfies("20.1.0", "workspace:*"), undefined)
console.log("semver ok")
