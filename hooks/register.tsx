import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, MergedPr, Note, OpenPr, PrData, SessionPr } from '../types'

const PANE = 'pr-tracker'
const POLL_MS = 120_000
const MERGED_WINDOW = 5

const empty: PrData = { open: [], merged: [], fetchedAt: 0, error: '', isLoading: false }
const data = atom({ plugin: 'pr-tracker', key: 'data' } as const, empty, { shape: 'data-1' })
const expanded = atom({ plugin: 'pr-tracker', key: 'expanded' } as const, 0, { shape: 'expanded-1' })
const mergedOffset = atom({ plugin: 'pr-tracker', key: 'mergedOffset' } as const, 0, { shape: 'offset-1' })
// PRs this session created; $.state is per session, so a new session starts empty.
const sessionPrs = atom({ plugin: 'pr-tracker', key: 'sessionPrs' } as const, [] as SessionPr[], { shape: 'session-1' })

const PR_JQ = `{number, title, url, state, isDraft, reviewDecision, mergeStateStatus, headRefName, updatedAt,
  checks: [(.statusCheckRollup // [])[] | {name: (.name // .context // ""), wf: (.workflowName // ""),
    status: (.status // ""), conclusion: (.conclusion // .state // ""), url: (.detailsUrl // .targetUrl // "")}],
  notes: ([(.comments // [])[] | {author: .author.login, body: .body[0:300], at: .createdAt, kind: "comment", state: ""}]
    + [(.reviews // [])[] | {author: .author.login, body: .body[0:300], at: .submittedAt, kind: "review", state: .state}])}`
const OPEN_JQ = `[.[] | ${PR_JQ}]`
const VIEW_FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,headRefName,updatedAt,statusCheckRollup,comments,reviews'
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/

async function gh($: EngineInterface, args: string[]): Promise<unknown> {
  const { exitCode, stdout, stderr } = await $.process.run(['gh', ...args], { timeoutMs: 60_000 })
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `gh exited ${exitCode}`)
  return JSON.parse(stdout)
}

async function refreshSession($: EngineInterface): Promise<void> {
  const prs = await read($, sessionPrs)
  const fresh = await Promise.all(
    prs.map(async pr => {
      try {
        return { ...(await gh($, ['pr', 'view', pr.url, '--json', VIEW_FIELDS, '--jq', PR_JQ])) as SessionPr, isFetched: true }
      } catch {
        return pr
      }
    }),
  )
  await update($, sessionPrs, list => list.map(pr => fresh.find(f => f.url === pr.url) ?? pr))
}

async function track($: EngineInterface, number: number, url: string): Promise<void> {
  let isNew = false
  await update($, sessionPrs, list => {
    if (list.some(pr => pr.url === url)) return list
    isNew = true
    const pending: SessionPr = {
      number, url, title: '', state: 'OPEN', isDraft: false, reviewDecision: '', mergeStateStatus: 'UNKNOWN',
      checks: [], notes: [], isFetched: false,
    }
    return [...list, pending]
  })
  if (isNew) void refreshSession($)
}

async function refresh($: EngineInterface): Promise<void> {
  void refreshSession($)
  await update($, data, d => ({ ...d, isLoading: true }))
  try {
    const [open, merged] = await Promise.all([
      gh($, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '30',
        '--json', 'number,title,url,isDraft,reviewDecision,mergeStateStatus,headRefName,updatedAt,statusCheckRollup,comments,reviews',
        '--jq', OPEN_JQ]),
      gh($, ['pr', 'list', '--author', '@me', '--state', 'merged', '--limit', '50',
        '--json', 'number,title,url,mergedAt']),
    ])
    const now = await $.clock.now()
    await update($, data, () => ({
      open: open as OpenPr[],
      merged: merged as MergedPr[],
      fetchedAt: now,
      error: '',
      isLoading: false,
    }))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, data, d => ({ ...d, error, isLoading: false }))
  }
}

function ago(iso: string | number, now: number): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!t) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function cut(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, Math.max(1, n - 1))}…` : one
}

type Ci = { pass: number; fail: number; pending: number; skip: number }
const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const SKIP = new Set(['SKIPPED', 'NEUTRAL'])

function ciOf(checks: Check[]): Ci {
  const ci = { pass: 0, fail: 0, pending: 0, skip: 0 }
  for (const c of checks) {
    if (FAIL.has(c.conclusion)) ci.fail++
    else if (SKIP.has(c.conclusion)) ci.skip++
    else if (c.conclusion === 'SUCCESS') ci.pass++
    else ci.pending++
  }
  return ci
}

function checkMark(c: Check): { mark: string; color: string } {
  if (FAIL.has(c.conclusion)) return { mark: '✗', color: 'red' }
  if (SKIP.has(c.conclusion)) return { mark: '–', color: 'gray' }
  if (c.conclusion === 'SUCCESS') return { mark: '✓', color: 'green' }
  return { mark: '●', color: 'yellow' }
}

const REVIEW: Record<string, { label: string; color: string }> = {
  APPROVED: { label: 'approved', color: 'green' },
  CHANGES_REQUESTED: { label: 'changes', color: 'red' },
  REVIEW_REQUIRED: { label: 'review', color: 'yellow' },
}

const MERGE: Record<string, { label: string; color: string }> = {
  CLEAN: { label: 'ready', color: 'green' },
  HAS_HOOKS: { label: 'ready', color: 'green' },
  UNSTABLE: { label: 'unstable', color: 'yellow' },
  BLOCKED: { label: 'blocked', color: 'yellow' },
  BEHIND: { label: 'behind', color: 'yellow' },
  DIRTY: { label: 'conflicts', color: 'red' },
  DRAFT: { label: 'draft', color: 'gray' },
  UNKNOWN: { label: '…', color: 'gray' },
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prs', description: 'Open the PR tracker pane (gh PRs, CI, comments)' })
    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    void $.ui.open({ id: PANE, title: 'My PRs' })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const pr = ran.result.gitOperation?.pr
    if (pr?.action === 'created' && pr.url) {
      await track($, pr.number, pr.url)
    } else if (/\bgh\s+pr\s+create\b/.test(e.command)) {
      const m = PR_URL.exec(ran.result.stdout)
      if (m) await track($, Number(m[1]), m[0])
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prs = await read($, sessionPrs)
    if (e.props.hasSurvey || prs.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.viewport?.columns ?? 80
    const STATE: Record<string, { label: string; color: string }> = {
      MERGED: { label: 'merged', color: 'magenta' },
      CLOSED: { label: 'closed', color: 'red' },
    }
    return (
      <Box flexDirection="column">
        {prs.map(pr => {
          const ci = ciOf(pr.checks)
          const st = STATE[pr.state] ?? (pr.isDraft ? MERGE.DRAFT! : MERGE[pr.mergeStateStatus] ?? { label: pr.mergeStateStatus.toLowerCase(), color: 'gray' })
          const review = pr.state === 'OPEN' ? REVIEW[pr.reviewDecision] : undefined
          return (
            <Box key={`s-${pr.url}`} flexDirection="row">
              {/* A Button, not a Link: where the terminal has no OSC 8, a Link prints its URL too. */}
              <Button key={`open-${pr.url}`} plain onPress={() => void $.process.run(['open', pr.url])}>{`#${pr.number}`}</Button>
              <Text wrap="truncate-end">
              {' '}<Text color={st.color}>{st.label}</Text>
              {review ? <Text color={review.color}> · {review.label}</Text> : ''}
              {pr.state === 'OPEN' && ci.pass + ci.fail + ci.pending > 0 ? <Text> · CI </Text> : ''}
              {pr.state === 'OPEN' && ci.pass > 0 ? <Text color="green">✓{ci.pass} </Text> : ''}
              {pr.state === 'OPEN' && ci.fail > 0 ? <Text color="red">✗{ci.fail} </Text> : ''}
              {pr.state === 'OPEN' && ci.pending > 0 ? <Text color="yellow">●{ci.pending} </Text> : ''}
              <Text dimColor> · 💬{pr.notes.length} </Text>
              {pr.isFetched ? cut(pr.title, Math.max(10, width - 40)) : <Text dimColor>loading…</Text>}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  on('command.run', { command: 'prs' }, async $ => {
    await $.ui.open({ id: PANE, title: 'My PRs' })
    void refresh($)
    return { text: 'PR tracker opened; refreshing.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const d = await read($, data)
    const open = await read($, expanded)
    const offset = await read($, mergedOffset)
    const now = await $.clock.now()
    const width = e.viewport?.columns ?? 80
    const titleRoom = Math.max(12, width - 34)

    const maxOffset = Math.max(0, d.merged.length - MERGED_WINDOW)
    const start = Math.min(offset, maxOffset)
    const shown = d.merged.slice(start, start + MERGED_WINDOW)
    const scrollBy = (by: number) => update($, mergedOffset, o => Math.min(maxOffset, Math.max(0, o + by)))

    const renderNote = (n: Note, i: number) => (
      <Box key={`note-${i}`} flexDirection="column" paddingLeft={4}>
        <Text>
          <Text bold>{n.author}</Text>
          {n.kind === 'review' ? <Text color={n.state === 'APPROVED' ? 'green' : n.state === 'CHANGES_REQUESTED' ? 'red' : 'gray'}> [{n.state.toLowerCase()}]</Text> : ''}
          <Text dimColor> {ago(n.at, now)} ago</Text>
        </Text>
        {n.body.trim() !== '' && <Text dimColor wrap="truncate-end">  {cut(n.body, Math.max(20, width - 10))}</Text>}
      </Box>
    )

    const renderOpen = (pr: OpenPr) => {
      const ci = ciOf(pr.checks)
      const merge = pr.isDraft ? MERGE.DRAFT! : MERGE[pr.mergeStateStatus] ?? { label: pr.mergeStateStatus.toLowerCase(), color: 'gray' }
      const review = REVIEW[pr.reviewDecision]
      const isOpen = open === pr.number
      const notes = [...pr.notes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      const checks = pr.checks.filter(c => !SKIP.has(c.conclusion))
      return (
        <Box key={`pr-${pr.number}`} flexDirection="column">
          <Button key={`row-${pr.number}`} plain onPress={() => void update($, expanded, x => (x === pr.number ? 0 : pr.number))}>
            {isOpen ? '▾' : '▸'} <Text bold>#{pr.number}</Text> {cut(pr.title, titleRoom)}
          </Button>
          <Text>
            {'    '}
            <Text color={merge.color}>{merge.label}</Text>
            {review ? <Text color={review.color}> · {review.label}</Text> : ''}
            <Text> · CI </Text>
            {ci.pass > 0 ? <Text color="green">✓{ci.pass} </Text> : ''}
            {ci.fail > 0 ? <Text color="red">✗{ci.fail} </Text> : ''}
            {ci.pending > 0 ? <Text color="yellow">●{ci.pending} </Text> : ''}
            {ci.pass + ci.fail + ci.pending === 0 ? <Text dimColor>none </Text> : ''}
            <Text dimColor>· 💬{pr.notes.length} · {ago(pr.updatedAt, now)}</Text>
          </Text>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={4}>
              <Text dimColor>{pr.headRefName} · <Link href={pr.url} label="open on GitHub" /></Text>
              <Text bold>Runs</Text>
              {checks.length === 0 && ci.skip === 0 && <Text dimColor>  no checks</Text>}
              {checks.map((c, i) => {
                const m = checkMark(c)
                return (
                  <Text key={`ck-${i}`}>
                    {'  '}<Text color={m.color}>{m.mark}</Text>{' '}
                    {c.url ? <Link href={c.url} label={cut(c.wf ? `${c.wf} / ${c.name}` : c.name, width - 12)} /> : cut(c.name, width - 12)}
                    <Text dimColor> {c.conclusion ? c.conclusion.toLowerCase() : c.status.toLowerCase()}</Text>
                  </Text>
                )
              })}
              {ci.skip > 0 && <Text dimColor>  +{ci.skip} skipped</Text>}
              <Text bold>Comments & reviews ({notes.length})</Text>
            </Box>
          )}
          {isOpen && notes.length === 0 && <Text dimColor>      none</Text>}
          {isOpen && notes.slice(-5).map(renderNote)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {d.isLoading ? 'refreshing…' : d.fetchedAt ? `updated ${ago(d.fetchedAt, now)} ago` : 'loading…'}
          </Text>
          <Button key="refresh" hotkey="r" dimColor onPress={() => void refresh($)}>Refresh</Button>
        </Box>
        {d.error !== '' && <Text color="red">gh: {d.error}</Text>}

        <Text bold>Open ({d.open.length})</Text>
        {d.fetchedAt > 0 && d.open.length === 0 && <Text dimColor>  No open PRs.</Text>}
        {d.open.map(renderOpen)}

        <Box flexDirection="row" gap={1} marginTop={1}>
          <Text bold>Merged ({d.merged.length})</Text>
          {d.merged.length > MERGED_WINDOW && (
            <Text dimColor>{start + 1}–{start + shown.length}</Text>
          )}
          {d.merged.length > MERGED_WINDOW && (
            <Button key="merged-up" hotkey="k" dimColor onPress={() => void scrollBy(-MERGED_WINDOW)}>▲</Button>
          )}
          {d.merged.length > MERGED_WINDOW && (
            <Button key="merged-down" hotkey="j" dimColor onPress={() => void scrollBy(MERGED_WINDOW)}>▼</Button>
          )}
        </Box>
        {shown.map(pr => (
          <Text key={`m-${pr.number}`}>
            {'  '}<Text color="magenta">⇣</Text> <Link href={pr.url} label={`#${pr.number}`} /> {cut(pr.title, titleRoom)}
            <Text dimColor> {ago(pr.mergedAt, now)}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
