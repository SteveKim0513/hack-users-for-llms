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

const BAND = {
  plugin: 'hack-users-for-llms',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const MOVE = { move: 'up', reason: '진척', done: false, pivot: false, new_destination: '', carry: 0 }
const verdict = (over: Record<string, unknown>) => JSON.stringify({ ...MOVE, ...over })

// A session in compass mode with one goal already set, the judge answering from `verdicts`.
async function withGoal($: any, on: any, verdicts: string[]) {
  const clock = mock.clock(on)
  const queue = [...verdicts]
  const sent: string[] = []
  const judged = { count: 0 }
  on('session.root', () => ({ value: '/proj' }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: e.key === 'mode:/proj' ? 'compass' : undefined }))
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__hack-users-for-llms__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', () => ({ text: 'engine' }))
  // Stands for the engine's own band when the plugin hands the draw on.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>(engine)</Text>
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sent.push(e.text)

    return { text: e.text }
  })
  on('model.complete', () => {
    judged.count += 1

    return { value: { isAnswered: true, text: queue.shift() ?? verdict({}), usage: USAGE } }
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__hack-users-for-llms__set_goal',
    destination: '랜딩 페이지 카피 확정',
    done: '헤드라인과 CTA 승인',
    avoid: '디자인 논의',
    steps: 2,
  })
  await $.turn.complete(turnEnd(1, '목표를 저장했어요'))
  await clock.advance(10)
  const turn = async (n: number) => {
    await $.turn.complete(turnEnd(n, '작업했어요'))
    await clock.advance(10)
  }

  return { turn, sent, judged, clock }
}

test('an achieved goal asks to finish, stops judging, and starts the next goal', async ($, on) => {
  const { turn, sent, judged, clock } = await withGoal($, on, [verdict({ done: true, reason: '카피 승인됨' })])
  await turn(2)
  expect(judged.count).toBe(1)

  // Waiting for the person: no more judging, whatever happens in between.
  await turn(3)
  expect(judged.count).toBe(1)

  const band = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await band.find({ type: 'Text', text: /목표를 달성한 것 같아요/ })).toBeTruthy()
  await band.press({ key: 'arrive-next' })
  await clock.advance(10)
  expect(sent[sent.length - 1]).toContain('방금 완료한 목표: "랜딩 페이지 카피 확정"')
  expect(await band.find({ type: 'Text', text: /목표를 달성한 것 같아요/ })).toBeFalsy()
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await pane.find({ type: 'Text', text: /아직 목표가 없어요/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /완료한 목표 1개/ })).toBeTruthy()
  await pane.unmount()

  // The interview can save the next goal.
  await $.tool.call({
    tool: 'mcp__hack-users-for-llms__set_goal',
    destination: '보도자료 초안',
    done: '대표 승인',
    avoid: '-',
    steps: 3,
  })
  const next = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await next.find({ type: 'Text', text: /진척 0\/3/ }))?.text).toContain('진척 0/3')
  await next.unmount()
})

test('"not yet" keeps the goal and judging goes on', async ($, on) => {
  const { turn, judged } = await withGoal($, on, [verdict({ done: true })])
  await turn(2)
  const band = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await band.press({ key: 'arrive-not-yet' })
  expect(await band.find({ type: 'Text', text: /목표를 달성한 것 같아요/ })).toBeFalsy()
  await band.unmount()

  await turn(3)
  expect(judged.count).toBe(2)
  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await pane.find({ type: 'Text', text: /진척 1\/2/ }))?.text).toContain('진척 1/2')
  expect(await pane.find({ type: 'Text', text: /사용자 확인: 아직 도착 전/ })).toBeTruthy()
  await pane.unmount()
})

test('"finish only" clears the goal without starting an interview', async ($, on) => {
  const { turn, sent } = await withGoal($, on, [verdict({ done: true })])
  await turn(2)
  const before = sent.length
  const band = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await band.press({ key: 'arrive-finish' })
  await band.unmount()
  expect(sent.length).toBe(before)
  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await pane.find({ type: 'Text', text: /완료한 목표 1개/ })).toBeTruthy()
  await pane.unmount()
})

test('using up the estimated steps is not arriving', async ($, on) => {
  const { turn, judged } = await withGoal($, on, [verdict({}), verdict({}), verdict({})])
  await turn(2)
  await turn(3)
  await turn(4)
  expect(judged.count).toBe(3)
  const band = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await band.find({ type: 'Text', text: /목표를 달성한 것 같아요/ })).toBeFalsy()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await pane.find({ type: 'Text', text: /진척 1\/2/ }))?.text).toContain('진척 1/2')
  await pane.unmount()
})

test('/compass after an achieved goal finishes it and starts from the new words', async ($, on) => {
  const { turn, sent, clock } = await withGoal($, on, [verdict({ done: true })])
  await turn(2)
  await ($ as any).command.run({ command: 'compass', args: '보도자료 초안' })
  await clock.advance(10)
  const last = sent[sent.length - 1]
  expect(last).toContain('방금 완료한 목표: "랜딩 페이지 카피 확정"')
  expect(last).toContain('사용자가 처음 꺼낸 생각: "보도자료 초안"')
})

// 엔진은 명령 처리 중의 prompt.submit을 거부한다. 이 시험이 그 거부를 잡는다.
test('/compass really starts the interview, and /compass words really start a change', async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('session.root', () => ({ value: '/proj' }))
  on('store.get', (_, e) => ({ value: e.key === 'mode:/proj' ? 'compass' : undefined }))
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__hack-users-for-llms__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.run', () => ({ text: 'engine' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })

  await ($ as any).command.run({ command: 'compass', args: '' })
  await clock.advance(10)
  expect(sent[sent.length - 1]).toContain('목표 지점을 정하는 인터뷰')

  await $.tool.call({
    tool: 'mcp__hack-users-for-llms__set_goal',
    destination: '카피',
    done: '승인',
    avoid: '-',
    steps: 2,
  })
  await ($ as any).command.run({ command: 'compass', args: '범위를 넓힌다' })
  await clock.advance(10)
  expect(sent[sent.length - 1]).toContain('목표를 고치고 싶어 합니다')
})
