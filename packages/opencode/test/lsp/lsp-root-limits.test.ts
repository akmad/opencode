import { afterEach, beforeEach, describe, expect, spyOn } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Layer } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { spawn } from "@/lsp/launch"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import type { InstanceContext } from "@/project/instance-context"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

// Covers the idle-eviction and per-server concurrency cap added on top of the
// deleted-root retirement in lsp-root-lifecycle.test.ts. Both new retirement
// reasons reuse `retire()`, so these tests assert on the same observable
// effects (fake-server "shutdown"/"exit" events, owned descendant teardown,
// `lsp.status()`) rather than reaching into LSP internals.

const lspLayer = LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]))
const it = testEffect(Layer.mergeAll(lspLayer, LayerNode.compile(CrossSpawnSpawner.node)))
const fakeServer = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

async function waitForFile(file: string) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    if (
      await fs
        .stat(file)
        .then(() => true)
        .catch(() => false)
    )
      return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

async function waitForEvent(file: string, event: string) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    if ((await fs.readFile(file, "utf8").catch(() => "")).split("\n").includes(event)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${event} in ${file}`)
}

async function waitForProcessExit(pid: number) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`)
}

async function waitForEndpoint(endpoint: string, available: boolean) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const live = await fetch(endpoint).then(
      (response) => response.ok,
      () => false,
    )
    if (live === available) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${endpoint} to become ${available ? "available" : "unavailable"}`)
}

async function stopProcess(pid: number) {
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

const baseConfig = {
  lsp: {
    deno: { disabled: true as const },
    eslint: { disabled: true as const },
    oxlint: { disabled: true as const },
    biome: { disabled: true as const },
  },
}

describe("LSP root limits", () => {
  let tsSpawnSpy: ReturnType<typeof spyOn>
  let tsRootSpy: ReturnType<typeof spyOn>
  let goSpawnSpy: ReturnType<typeof spyOn>
  let goRootSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tsSpawnSpy = spyOn(LSPServer.Typescript, "spawn")
    tsRootSpy = spyOn(LSPServer.Typescript, "root")
    goSpawnSpy = spyOn(LSPServer.Gopls, "spawn")
    goRootSpy = spyOn(LSPServer.Gopls, "root")
  })

  afterEach(() => {
    tsSpawnSpy.mockRestore()
    tsRootSpy.mockRestore()
    goSpawnSpy.mockRestore()
    goRootSpy.mockRestore()
  })

  it.instance(
    "retires an idle root once past the configured TTL, tearing down its owned descendant",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const events = path.join(dir, "idle-events")
          const descendant = path.join(dir, "idle-descendant-pid")
          let descendantPID: number | undefined
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              if (descendantPID) await stopProcess(descendantPID)
            }),
          )
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          tsSpawnSpy.mockImplementation(async (root: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: root,
              env: {
                ...process.env,
                OPENCODE_TEST_LSP_EVENT_FILE: events,
                OPENCODE_TEST_LSP_RECORD_START: "1",
                OPENCODE_TEST_LSP_DESCENDANT_EVENT_FILE: events,
                OPENCODE_TEST_LSP_DESCENDANT_PID_FILE: descendant,
                OPENCODE_TEST_LSP_DESCENDANT_EXPIRY_MS: "10000",
              },
            }),
          }))

          yield* lsp.hover({ file, line: 0, character: 0 })
          expect(yield* lsp.status()).toHaveLength(1)
          yield* Effect.promise(() => waitForEvent(events, "descendant-start"))
          const [pid, endpoint] = yield* Effect.promise(() =>
            fs.readFile(descendant, "utf8").then((value) => value.split("\n")),
          )
          if (!pid || !endpoint) throw new Error("Descendant did not publish its process and endpoint")
          descendantPID = Number(pid)
          yield* Effect.promise(() => waitForEndpoint(endpoint, true))

          // Never touched again: the periodic reconcile sweep (every 250ms)
          // must retire it once its idle age passes the 150ms TTL below.
          yield* Effect.promise(() => waitForEvent(events, "exit"))
          yield* Effect.promise(() => waitForProcessExit(descendantPID!))
          yield* Effect.promise(() => waitForEndpoint(endpoint, false))
          expect(tsSpawnSpy).toHaveBeenCalledTimes(1)
          expect(yield* lsp.status()).toEqual([])
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { idle_timeout: 150 } } },
  )

  it.instance(
    "does not retire a root that keeps being used within the TTL",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const events = path.join(dir, "fresh-events")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          tsSpawnSpy.mockImplementation(async (root: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: root,
              env: { ...process.env, OPENCODE_TEST_LSP_EVENT_FILE: events, OPENCODE_TEST_LSP_RECORD_START: "1" },
            }),
          }))

          yield* lsp.hover({ file, line: 0, character: 0 })
          yield* Effect.promise(() => Bun.sleep(300))
          // Refresh last-used before the 500ms TTL elapses; several reconcile
          // ticks (250ms apart) run across this test and must not retire it.
          yield* lsp.hover({ file, line: 0, character: 0 })
          yield* Effect.promise(() => Bun.sleep(300))

          expect(tsSpawnSpy).toHaveBeenCalledTimes(1)
          expect(yield* lsp.status()).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readFile(events, "utf8"))).not.toContain("shutdown")
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { idle_timeout: 500 } } },
  )

  it.instance(
    "still retires an idle root while global broadcasts keep fanning over every client",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const events = path.join(dir, "broadcast-events")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          tsSpawnSpy.mockImplementation(async (root: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: root,
              env: { ...process.env, OPENCODE_TEST_LSP_EVENT_FILE: events, OPENCODE_TEST_LSP_RECORD_START: "1" },
            }),
          }))

          yield* lsp.hover({ file, line: 0, character: 0 })

          // `diagnostics()` fans out over every client via `runAll`. It is a
          // routine post-edit call, so if it counted as "using" each root it
          // would reset all their idle timers together and idle eviction could
          // never fire -- which is precisely how one session accumulated 15
          // live TypeScript servers. A broadcast is a global question, not
          // evidence that any particular root is in use.
          for (let i = 0; i < 8; i++) {
            yield* lsp.diagnostics()
            yield* Effect.promise(() => Bun.sleep(100))
          }

          expect(yield* lsp.status()).toHaveLength(0)
          expect(yield* Effect.promise(() => fs.readFile(events, "utf8"))).toContain("shutdown")
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { idle_timeout: 500 } } },
  )

  it.instance(
    "retires the least-recently-used root once the per-server cap is exceeded, keeping the most-recently-used one",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const rootA = path.join(dir, "root-a")
          const rootB = path.join(dir, "root-b")
          const rootC = path.join(dir, "root-c")
          const [fileA, fileB, fileC] = [rootA, rootB, rootC].map((root) => path.join(root, "sample.ts"))
          const [eventsA, eventsB, eventsC] = [rootA, rootB, rootC].map((root) => `${root}-events`)
          yield* Effect.promise(async () => {
            await Promise.all([fs.mkdir(rootA), fs.mkdir(rootB), fs.mkdir(rootC)])
            await Promise.all(
              [fileA, fileB, fileC].map((file) => Bun.write(file, "export const sample = 1\n")),
            )
          })
          tsRootSpy.mockImplementation(async (input: string) => path.dirname(input))
          tsSpawnSpy.mockImplementation(async (serverRoot: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: serverRoot,
              env: {
                ...process.env,
                OPENCODE_TEST_LSP_EVENT_FILE:
                  serverRoot === rootA ? eventsA : serverRoot === rootB ? eventsB : eventsC,
                OPENCODE_TEST_LSP_RECORD_START: "1",
              },
            }),
          }))

          yield* lsp.hover({ file: fileA, line: 0, character: 0 })
          yield* lsp.hover({ file: fileB, line: 0, character: 0 })
          expect(yield* lsp.status()).toHaveLength(2)

          // A third distinct root for the same server id exceeds the cap of
          // 2: A is the least-recently-used and must be retired first.
          yield* lsp.hover({ file: fileC, line: 0, character: 0 })

          yield* Effect.promise(() => waitForEvent(eventsA, "exit"))
          expect(tsSpawnSpy).toHaveBeenCalledTimes(3)
          expect(yield* lsp.status()).toHaveLength(2)
          expect(yield* Effect.promise(() => fs.readFile(eventsB, "utf8"))).not.toContain("shutdown")
          expect(yield* Effect.promise(() => fs.readFile(eventsC, "utf8"))).not.toContain("shutdown")
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { max_concurrent: 2 } } },
  )

  it.instance(
    "caps each server id independently, so one server id's eviction never touches another",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const rootT1 = path.join(dir, "root-t1")
          const rootT2 = path.join(dir, "root-t2")
          const rootG1 = path.join(dir, "root-g1")
          const fileT1 = path.join(rootT1, "sample.ts")
          const fileT2 = path.join(rootT2, "sample.ts")
          const fileG1 = path.join(rootG1, "sample.go")
          const eventsT1 = `${rootT1}-events`
          const eventsT2 = `${rootT2}-events`
          const eventsG1 = `${rootG1}-events`
          yield* Effect.promise(async () => {
            await Promise.all([fs.mkdir(rootT1), fs.mkdir(rootT2), fs.mkdir(rootG1)])
            await Promise.all([
              Bun.write(fileT1, "export const sample = 1\n"),
              Bun.write(fileT2, "export const sample = 1\n"),
              Bun.write(fileG1, "package main\n"),
            ])
          })
          tsRootSpy.mockImplementation(async (input: string) => path.dirname(input))
          goRootSpy.mockImplementation(async (input: string) => path.dirname(input))
          tsSpawnSpy.mockImplementation(async (serverRoot: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: serverRoot,
              env: {
                ...process.env,
                OPENCODE_TEST_LSP_EVENT_FILE: serverRoot === rootT1 ? eventsT1 : eventsT2,
                OPENCODE_TEST_LSP_RECORD_START: "1",
              },
            }),
          }))
          goSpawnSpy.mockImplementation(async (serverRoot: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: serverRoot,
              env: { ...process.env, OPENCODE_TEST_LSP_EVENT_FILE: eventsG1, OPENCODE_TEST_LSP_RECORD_START: "1" },
            }),
          }))

          yield* lsp.hover({ file: fileT1, line: 0, character: 0 })
          yield* lsp.hover({ file: fileG1, line: 0, character: 0 })
          expect(yield* lsp.status()).toHaveLength(2)

          // A second typescript root exceeds typescript's cap of 1 and must
          // retire T1, but must never touch the unrelated gopls root.
          yield* lsp.hover({ file: fileT2, line: 0, character: 0 })

          yield* Effect.promise(() => waitForEvent(eventsT1, "exit"))
          expect(tsSpawnSpy).toHaveBeenCalledTimes(2)
          expect(goSpawnSpy).toHaveBeenCalledTimes(1)
          expect(yield* lsp.status()).toHaveLength(2)
          expect(yield* Effect.promise(() => fs.readFile(eventsG1, "utf8"))).not.toContain("shutdown")
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { max_concurrent: 1 } } },
  )

  it.instance(
    "never evicts a root whose client is still initializing when the idle sweep runs",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const events = path.join(dir, "stuck-events")
          const release = path.join(dir, "stuck-release")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))
          tsSpawnSpy.mockImplementation(async (root: string) => ({
            process: spawn(process.execPath, [fakeServer], {
              cwd: root,
              env: {
                ...process.env,
                OPENCODE_TEST_LSP_EVENT_FILE: events,
                OPENCODE_TEST_LSP_RECORD_START: "1",
                OPENCODE_TEST_LSP_RECORD_INITIALIZE: "1",
                OPENCODE_TEST_LSP_INITIALIZE_RELEASE_FILE: release,
              },
            }),
          }))

          const pending = yield* lsp.hover({ file, line: 0, character: 0 }).pipe(Effect.forkScoped)
          yield* Effect.promise(() => waitForEvent(events, "initialize"))

          // The record has no client yet, so several idle sweeps (well past
          // the 50ms TTL) must leave the still-initializing process alone.
          yield* Effect.promise(() => Bun.sleep(700))
          expect(yield* Effect.promise(() => fs.readFile(events, "utf8"))).not.toContain("exit")
          expect(yield* lsp.status()).toEqual([])

          yield* Effect.promise(() => Bun.write(release, "release"))
          yield* awaitWithTimeout(Fiber.join(pending), "stuck hover did not settle after release")
          expect(tsSpawnSpy).toHaveBeenCalledTimes(1)
          expect(yield* lsp.status()).toHaveLength(1)
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { idle_timeout: 50 } } },
  )

  it.instance(
    "never evicts a root whose client is still initializing when the per-server cap is exceeded",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const rootA = path.join(dir, "stuck-root")
          const rootB = path.join(dir, "fast-root-b")
          const rootC = path.join(dir, "fast-root-c")
          const fileA = path.join(rootA, "sample.ts")
          const fileB = path.join(rootB, "sample.ts")
          const fileC = path.join(rootC, "sample.ts")
          const eventsA = `${rootA}-events`
          const eventsB = `${rootB}-events`
          const eventsC = `${rootC}-events`
          const release = path.join(dir, "cap-stuck-release")
          yield* Effect.promise(async () => {
            await Promise.all([fs.mkdir(rootA), fs.mkdir(rootB), fs.mkdir(rootC)])
            await Promise.all([
              Bun.write(fileA, "export const sample = 1\n"),
              Bun.write(fileB, "export const sample = 1\n"),
              Bun.write(fileC, "export const sample = 1\n"),
            ])
          })
          yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))
          tsRootSpy.mockImplementation(async (input: string) => path.dirname(input))
          tsSpawnSpy.mockImplementation(async (serverRoot: string) => {
            if (serverRoot === rootA) {
              return {
                process: spawn(process.execPath, [fakeServer], {
                  cwd: serverRoot,
                  env: {
                    ...process.env,
                    OPENCODE_TEST_LSP_EVENT_FILE: eventsA,
                    OPENCODE_TEST_LSP_RECORD_START: "1",
                    OPENCODE_TEST_LSP_RECORD_INITIALIZE: "1",
                    OPENCODE_TEST_LSP_INITIALIZE_RELEASE_FILE: release,
                  },
                }),
              }
            }
            return {
              process: spawn(process.execPath, [fakeServer], {
                cwd: serverRoot,
                env: {
                  ...process.env,
                  OPENCODE_TEST_LSP_EVENT_FILE: serverRoot === rootB ? eventsB : eventsC,
                  OPENCODE_TEST_LSP_RECORD_START: "1",
                },
              }),
            }
          })

          // rootA is created first (oldest record) but never finishes
          // handshaking, so it must never be chosen as the LRU candidate
          // even though its record looks the oldest.
          const pending = yield* lsp.hover({ file: fileA, line: 0, character: 0 }).pipe(Effect.forkScoped)
          yield* Effect.promise(() => waitForEvent(eventsA, "initialize"))

          yield* lsp.hover({ file: fileB, line: 0, character: 0 })
          expect(yield* lsp.status()).toHaveLength(1)

          // rootC exceeds the cap of 1 live client: only rootB (the sole
          // live record) is eligible, never the still-initializing rootA.
          yield* lsp.hover({ file: fileC, line: 0, character: 0 })
          yield* Effect.promise(() => waitForEvent(eventsB, "exit"))
          expect(yield* Effect.promise(() => fs.readFile(eventsA, "utf8"))).not.toContain("shutdown")
          expect(yield* Effect.promise(() => fs.readFile(eventsA, "utf8"))).not.toContain("exit")

          yield* Effect.promise(() => Bun.write(release, "release"))
          yield* awaitWithTimeout(Fiber.join(pending), "stuck hover did not settle after release")
          expect(tsSpawnSpy).toHaveBeenCalledTimes(3)
          expect(yield* lsp.status()).toHaveLength(2)
        }),
      ),
    { config: { ...baseConfig, lsp_limits: { max_concurrent: 1 } } },
  )
})
