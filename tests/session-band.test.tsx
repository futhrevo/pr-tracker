import { expect, test } from 'claude-code/testing'

// The test runtime has timers; the mod's lib (no DOM) does not declare them.
declare function setTimeout(fn: () => void, ms: number): unknown
type StubOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const URL = 'https://github.com/octo-org/demo/pull/2290'

const view = {
  number: 2290, title: 'feat: session band', url: URL, state: 'OPEN', isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', headRefName: 'x', updatedAt: '2026-10-29T00:00:00Z',
  checks: [{ name: 'build', wf: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', url: '' }],
  notes: [],
}

function stubEngine(on: StubOn) {
  on('command.register', () => ({ value: { command: 'prs' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const stdout = args.includes('pr view') ? JSON.stringify(view) : '[]'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const BAND = { plugin: 'pr-tracker', component: 'AbovePrompt', surface: 'terminal' } as const

test('a PR created through gh shows in the band', async ($, on) => {
  stubEngine(on)
  on('tool.call', () => ({
    result: { stdout: `${URL}\n`, stderr: '', interrupted: false, gitOperation: { pr: { number: 2290, url: URL, action: 'created' } } },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x --body y' })
  await new Promise<void>(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isTurnRunning: false } } as never)
  expect((await ui.find({ type: 'Button', text: /#2290/ }))?.text).toBe('#2290')
  const row = await ui.find({ type: 'Text', text: /feat: session band/ })
  expect(row?.text).toContain('blocked')
  expect(row?.text).not.toContain('session PR')
  expect(row?.text).not.toContain('github.com')
  await ui.unmount()
})

test('without a gitOperation the gh pr create stdout URL is used', async ($, on) => {
  stubEngine(on)
  on('tool.call', () => ({ result: { stdout: `Creating pull request\n${URL}\n`, stderr: '', interrupted: false } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await new Promise<void>(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isTurnRunning: false } } as never)
  expect((await ui.find({ type: 'Button', text: /#2290/ }))?.text).toBe('#2290')
  await ui.unmount()
})

test('other Bash calls add nothing to the band', async ($, on) => {
  stubEngine(on)
  on('tool.call', () => ({ result: { stdout: URL, stderr: '', interrupted: false } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 2290' })
  await new Promise<void>(r => setTimeout(r, 50))

  const ui = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isTurnRunning: false } } as never)
  expect(await ui.find({ type: 'Button', text: /#2290/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
