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
import { TestInstance, disposeAllInstancesEffect, reloadInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

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

const config = {
  lsp: {
    deno: { disabled: true as const },
    eslint: { disabled: true as const },
    oxlint: { disabled: true as const },
    biome: { disabled: true as const },
  },
}

describe("LSP root lifecycle", () => {
  let spawnSpy: ReturnType<typeof spyOn>
  let rootSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnSpy = spyOn(LSPServer.Typescript, "spawn")
    rootSpy = spyOn(LSPServer.Typescript, "root")
  })

  afterEach(() => {
    spawnSpy.mockRestore()
    rootSpy.mockRestore()
  })

  it.instance(
    "shares one live server while concurrent requests initialize the same root",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          spawnSpy.mockImplementation(async (root: string) => ({
            process: spawn(process.execPath, [fakeServer], { cwd: root }),
          }))

          yield* Effect.all([lsp.hover({ file, line: 0, character: 0 }), lsp.hover({ file, line: 0, character: 0 })], {
            concurrency: "unbounded",
          })

          expect(spawnSpy).toHaveBeenCalledTimes(1)
          expect(yield* lsp.status()).toHaveLength(1)
        }),
      ),
    { config },
  )

  it.instance(
    "does not register work after reload disposes a root-gated state",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const release = path.join(dir, "root-release")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          let started!: () => void
          const startedPromise = new Promise<void>((resolve) => {
            started = resolve
          })
          let first = true
          rootSpy.mockImplementation(async (_file: string, ctx: InstanceContext) => {
            if (!first) return ctx.directory
            first = false
            started()
            await waitForFile(release)
            return ctx.directory
          })
          spawnSpy.mockImplementation(async (root: string) => ({
            process: spawn(process.execPath, [fakeServer], { cwd: root }),
          }))
          yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))

          const pending = yield* lsp.hover({ file, line: 0, character: 0 }).pipe(Effect.forkScoped)
          yield* Effect.promise(() => startedPromise)
          yield* reloadInstance({ directory: dir })
          yield* Effect.promise(() => Bun.write(release, "release"))
          yield* awaitWithTimeout(Fiber.join(pending), "root-gated request did not settle")
          expect(spawnSpy).toHaveBeenCalledTimes(0)

          yield* lsp.hover({ file, line: 0, character: 0 })
          expect(spawnSpy).toHaveBeenCalledTimes(1)
          expect(yield* lsp.status()).toHaveLength(1)
        }),
      ),
    { config },
  )

  it.instance(
    "stops a returned handle when disposal interrupts initialization",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const events = path.join(dir, "events")
          const release = path.join(dir, "initialize-release")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          let handle: ReturnType<typeof spawn> | undefined
          spawnSpy.mockImplementation(async (root: string) => {
            const proc = spawn(process.execPath, [fakeServer], {
              cwd: root,
              env: {
                ...process.env,
                OPENCODE_TEST_LSP_EVENT_FILE: events,
                OPENCODE_TEST_LSP_INITIALIZE_RELEASE_FILE: release,
                OPENCODE_TEST_LSP_RECORD_INITIALIZE: "1",
              },
            })
            handle = proc
            return { process: proc }
          })

          const pending = yield* lsp.hover({ file, line: 0, character: 0 }).pipe(Effect.forkScoped)
          yield* Effect.promise(() => waitForFile(events))
          expect(yield* Effect.promise(() => fs.readFile(events, "utf8"))).toContain("initialize\n")

          yield* disposeAllInstancesEffect
          expect(handle).toBeDefined()
          const pendingHandle = handle
          if (pendingHandle) yield* Effect.promise(() => pendingHandle.exited)
          yield* Fiber.interrupt(pending)
        }),
      ),
    { config },
  )

  it.instance(
    "stops a handle returned by a retired spawn without disturbing its replacement",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "sample.ts")
          const release = path.join(dir, "spawn-release")
          const staleEvents = path.join(dir, "stale-events")
          yield* Effect.promise(() => Bun.write(file, "export const sample = 1\n"))
          let started!: () => void
          const startedPromise = new Promise<void>((resolve) => {
            started = resolve
          })
          let staleReady!: (handle: ReturnType<typeof spawn>) => void
          const staleHandle = new Promise<ReturnType<typeof spawn>>((resolve) => {
            staleReady = resolve
          })
          let first = true
          spawnSpy.mockImplementation(async (root: string) => {
            if (!first) return { process: spawn(process.execPath, [fakeServer], { cwd: root }) }
            first = false
            started()
            await waitForFile(release)
            const stale = spawn(process.execPath, [fakeServer], {
              cwd: root,
              env: {
                ...process.env,
                OPENCODE_TEST_LSP_EVENT_FILE: staleEvents,
                OPENCODE_TEST_LSP_RECORD_START: "1",
                OPENCODE_TEST_LSP_RECORD_INITIALIZE: "1",
              },
            })
            staleReady(stale)
            return { process: stale }
          })
          yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")))

          const pending = yield* lsp.hover({ file, line: 0, character: 0 }).pipe(Effect.forkScoped)
          yield* Effect.promise(() => startedPromise)
          yield* reloadInstance({ directory: dir })

          yield* lsp.hover({ file, line: 0, character: 0 })
          expect(yield* lsp.status()).toHaveLength(1)

          yield* Effect.promise(() => Bun.write(release, "release"))
          yield* Effect.promise(async () => (await staleHandle).exited)
          expect(yield* Effect.promise(() => fs.readFile(staleEvents, "utf8").catch(() => ""))).not.toContain(
            "initialize",
          )
          yield* awaitWithTimeout(Fiber.join(pending), "retired spawn did not settle")
          expect(yield* lsp.status()).toHaveLength(1)
        }),
      ),
    { config },
  )
})
