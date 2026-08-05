/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import { currentSessionRows } from "../../src/routes/session/sidebar"

const session = (input: Partial<Session> & Pick<Session, "id">) =>
  ({
    title: input.id,
    directory: "/project",
    time: { created: 0, updated: 0 },
    ...input,
  }) as Session

const day = 24 * 60 * 60 * 1000
const now = 2 * day

test("includes current and sessions updated within the cutoff", () => {
  const rows = currentSessionRows(
    [
      session({ id: "current", time: { created: 0, updated: 0 } }),
      session({ id: "recent", time: { created: now - day, updated: now - day } }),
      session({ id: "old", parentID: "current", time: { created: now - day - 1, updated: now - day - 1 } }),
    ],
    "current",
    {},
    {},
    {},
    now,
  )

  expect(rows.map((row) => row.session.id)).toEqual(["current", "recent"])
  expect(rows[0]?.current).toBe(true)
  expect(rows[1]?.current).toBe(false)
})

test("lists only top-level sessions and highlights the current session root", () => {
  const rows = currentSessionRows(
    [
      session({ id: "root", time: { created: 0, updated: 0 } }),
      session({ id: "current", parentID: "root", time: { created: now, updated: now } }),
      session({ id: "subagent", parentID: "root", time: { created: now, updated: now } }),
      session({ id: "recent", time: { created: now, updated: now } }),
    ],
    "current",
    {},
    {},
    {},
    now,
  )

  expect(rows.map((row) => [row.session.id, row.current])).toEqual([
    ["root", true],
    ["recent", false],
  ])
})

test("uses unvisited subagent activity for its top-level session", () => {
  const rows = currentSessionRows(
    [
      session({ id: "current", time: { created: 0, updated: 0 } }),
      session({ id: "active-root", time: { created: 0, updated: now - day - 1 } }),
      session({ id: "subagent", parentID: "active-root", time: { created: now, updated: now } }),
      session({ id: "recent", time: { created: now - 1, updated: now - 1 } }),
    ],
    "current",
    { subagent: { type: "busy" } },
    {},
    {},
    now,
  )

  expect(rows.map((row) => [row.session.id, row.state])).toEqual([
    ["current", "idle"],
    ["active-root", "working"],
    ["recent", "idle"],
  ])
})

test("limits recent sessions to the current project path", () => {
  const rows = currentSessionRows(
    [
      session({ id: "current", projectID: "project", path: "src", time: { created: now, updated: now } }),
      session({ id: "child", projectID: "project", path: "src/components", time: { created: now, updated: now } }),
      session({ id: "sibling", projectID: "project", path: "test", time: { created: now, updated: now } }),
      session({ id: "other", projectID: "other", path: "src", time: { created: now, updated: now } }),
    ],
    "current",
    {},
    {},
    {},
    now,
  )

  expect(rows.map((row) => row.session.id)).toEqual(["current", "child"])
})

test("sorts non-current sessions by updated time then ID", () => {
  const rows = currentSessionRows(
    [
      session({ id: "z", time: { created: now - 3, updated: now - 3 } }),
      session({ id: "a", time: { created: now - 3, updated: now - 3 } }),
      session({ id: "current", time: { created: 0, updated: 0 } }),
      session({ id: "newer", time: { created: now - 2, updated: now - 2 } }),
    ],
    "current",
    {},
    {},
    {},
    now,
  )

  expect(rows.map((row) => row.session.id)).toEqual(["current", "newer", "a", "z"])
})

test("maps permission and question precedence before working and idle", () => {
  const rows = currentSessionRows(
    [
      session({ id: "current", time: { created: now, updated: now } }),
      session({ id: "permission", time: { created: now, updated: now } }),
      session({ id: "question", time: { created: now, updated: now } }),
      session({ id: "both", time: { created: now, updated: now } }),
      session({ id: "busy", time: { created: now, updated: now } }),
      session({ id: "retry", time: { created: now, updated: now } }),
      session({ id: "idle", time: { created: now, updated: now } }),
    ],
    "current",
    { busy: { type: "busy" }, retry: { type: "retry", attempt: 1, message: "", next: now } },
    {
      permission: [{ id: "permission" } as PermissionRequest],
      both: [{ id: "permission" } as PermissionRequest],
    },
    { question: [{ id: "question" } as QuestionRequest], both: [{ id: "question" } as QuestionRequest] },
    now,
  )

  expect(Object.fromEntries(rows.map((row) => [row.session.id, row.state]))).toEqual({
    current: "idle",
    both: "permission",
    busy: "working",
    idle: "idle",
    permission: "permission",
    question: "question",
    retry: "working",
  })
})
