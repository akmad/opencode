import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import type { PermissionRequest, QuestionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { useRoute } from "../../context/route"
import { Spinner } from "../../component/spinner"

export type CurrentSessionState = "permission" | "question" | "working" | "idle"

export function currentSessionRows(
  sessions: Session[],
  rootID: string,
  status: Record<string, SessionStatus>,
  permissions: Record<string, PermissionRequest[]>,
  questions: Record<string, QuestionRequest[]>,
  now: number,
) {
  const current = sessions.find((session) => session.id === rootID)
  if (!current) return []
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const root = (session: Session) => {
    const visited = new Set<string>()
    let current = session
    while (current.parentID && !visited.has(current.parentID)) {
      visited.add(current.parentID)
      const parent = byID.get(current.parentID)
      if (!parent) return
      current = parent
    }
    if (current.parentID) return
    return current
  }
  const currentRoot = root(current) ?? current
  const scoped = sessions.filter((session) => {
    if (session.projectID !== current.projectID) return false
    if (
      current.path &&
      session.path !== current.path &&
      !session.path?.startsWith(`${current.path}/`) &&
      (session.path || session.directory !== current.directory)
    ) {
      return false
    }
    return true
  })

  return scoped
    .filter((session) => !session.parentID)
    .map((session) => {
      const related = scoped.filter((candidate) => root(candidate)?.id === session.id)
      const state: CurrentSessionState =
        related.some((candidate) => (permissions[candidate.id]?.length ?? 0) > 0)
          ? "permission"
          : related.some((candidate) => (questions[candidate.id]?.length ?? 0) > 0)
            ? "question"
            : related.some(
                  (candidate) => status[candidate.id]?.type === "busy" || status[candidate.id]?.type === "retry",
                )
              ? "working"
              : "idle"
      return {
        session,
        state,
        current: session.id === currentRoot.id,
        updated: Math.max(...related.map((candidate) => candidate.time.updated)),
      }
    })
    .filter((row) => row.current || row.updated >= now - 24 * 60 * 60 * 1000)
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      return b.updated - a.updated || a.session.id.localeCompare(b.session.id)
    })
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const route = useRoute()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const interval = setInterval(() => setNow(Date.now()), 60 * 1000)
    onCleanup(() => clearInterval(interval))
  })
  const current = createMemo(() =>
    currentSessionRows(
      sync.data.session,
      props.sessionID,
      sync.data.session_status,
      sync.data.permission,
      sync.data.question,
      now(),
    ),
  )
  const [currentOpen, setCurrentOpen] = createSignal(true)

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <Show when={current().length > 0}>
          <box flexShrink={0} marginTop={1} gap={0}>
            <box flexDirection="row" gap={1} onMouseDown={() => setCurrentOpen((value) => !value)}>
              <text fg={theme.textMuted}>{currentOpen() ? "▼" : "▶"}</text>
              <text fg={theme.textMuted}>Sessions</text>
            </box>
            <Show when={currentOpen()}>
              <For each={current()}>
                {(item) => (
                  <box flexDirection="row" gap={1} onMouseUp={() => route.navigate({ type: "session", sessionID: item.session.id })}>
                    <Show
                      when={item.state === "working"}
                      fallback={
                        <text
                          fg={
                            item.state === "permission"
                              ? theme.warning
                              : item.state === "question"
                                ? theme.warning
                                : theme.textMuted
                          }
                        >
                          {item.state === "permission" ? "△" : item.state === "question" ? "?" : "•"}
                        </text>
                      }
                    >
                      <Spinner color={theme.primary} />
                    </Show>
                    <text fg={theme.text} wrapMode="none">
                      {item.current ? <b>{Locale.truncate(item.session.title, 26)}</b> : Locale.truncate(item.session.title, 26)}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>
        </Show>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
