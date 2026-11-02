import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'hack-users-for-llms',
  component: 'Pane',
  requestId: 'compass',
  props: {
    title: '목표 여정',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const turnEnd = (n: number, answer: string) => ({
  answer,
  durationMs: 1000,
  isAborted: false,
  turnId: `t${n}`,
  reason: 'answer' as const,
})

test('a goal, two judged turns and a confirmed pivot draw on every surface', async ($, on) => {
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/proj' }))
  on('store.get', (_, e) => ({ value: e.key === 'mode:/proj' ? 'compass' : undefined }))
  const verdicts = [
    '{"move":"up","reason":"구조 결정","done":false,"pivot":false,"new_destination":"","carry":0}',
    '{"move":"down","reason":"범위 밖 디자인 논의","done":false,"pivot":true,"new_destination":"앱 화면 시안","carry":1}',
  ]
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__hack-users-for-llms__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: verdicts.shift() ?? '', usage: USAGE },
  }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  // Setup turn: the model saves the goal card; this turn is not judged.
  await $.tool.call({
    tool: 'mcp__hack-users-for-llms__set_goal',
    destination: '랜딩 페이지 카피 확정',
    done: '헤드라인과 CTA 승인',
    avoid: '디자인 논의',
    steps: 4,
  })
  await $.turn.complete(turnEnd(1, '목표를 저장했어요'))
  await clock.advance(10)

  await $.turn.complete(turnEnd(2, '헤드라인 세 안을 냈어요'))
  await clock.advance(10)
  await $.turn.complete(turnEnd(3, '색상 팔레트를 골라 봤어요'))
  await clock.advance(10)

  for (const surface of ['terminal', 'vscode', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /진척 0\/4/ }))?.text).toContain('진척 0/4')
    expect(await ui.find({ type: 'Text', text: /범위 밖 디자인 논의/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /목표가 바뀐 건가요/ })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'pivot-yes' })
  expect((await ui.find({ type: 'Text', text: /앱 화면 시안/ }))?.text).toContain('앱 화면 시안')
  expect((await ui.find({ type: 'Text', text: /진척 1\/4/ }))?.text).toContain('진척 1/4')
  expect(await ui.find({ type: 'Text', text: /목표가 바뀐 건가요/ })).toBeFalsy()
  await ui.unmount()
})

test('no goal: the pane offers to start, and turns are not judged', async ($, on) => {
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/proj' }))
  on('store.get', (_, e) => ({ value: e.key === 'mode:/proj' ? 'compass' : undefined }))
  let calls = 0
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => {
    calls += 1

    return { value: { isAnswered: true, text: '{}', usage: USAGE } }
  })
  await $.session.start({ cwd: '/proj', surface: 'vscode', isInteractive: true })
  await $.turn.complete(turnEnd(1, 'hello'))
  await clock.advance(10)
  expect(calls).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /아직 목표가 없어요/ }))?.text).toBe('아직 목표가 없어요')
  await ui.unmount()
})
