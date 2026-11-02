import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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

const USAGE = {
  input_tokens: 10,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const MOVE = { move: 'up', reason: '진척', done: false, pivot: false, new_destination: '', carry: 0 }

const CHOICE = JSON.stringify({
  ...MOVE,
  ask: true,
  kind: 'distinction',
  question: '여기서 말한 "사용자"는 가입자인가요, 결제 고객인가요?',
  options: ['가입자', '결제 고객'],
  quote: '사용자 이탈 원인을 정리해줘',
  why: '대상에 따라 분석이 달라짐',
})

const FREE = JSON.stringify({
  ...MOVE,
  ask: true,
  kind: 'premise',
  question: '이 기획은 어떤 독자를 전제로 하나요?',
  options: [],
  quote: '매거진 기획해줘',
  why: '독자 전제가 빠짐',
})

const NONE = JSON.stringify({ ...MOVE, ask: false })

const turnEnd = (n: number, answer: string) => ({
  answer,
  durationMs: 1000,
  isAborted: false,
  turnId: `t${n}`,
  reason: 'answer' as const,
})

// Stands for the engine beneath the plugin: a project at /proj, HOME at /home,
// files from `files`, the judge answering from `verdicts`; records what the plugin sends.
function engine(on: On, files: Record<string, string>, verdicts: string[]) {
  const sent: { text: string; context: readonly string[] }[] = []
  const systems: string[] = []
  mock.env(on, { HOME: '/home' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'compass' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__hack-users-for-llms__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_, e) => ({
    value: Object.keys(files).some(p => p === e.path || p.startsWith(`${e.path}/`)),
  }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('model.complete', (_, e) => {
    systems.push(e.system ?? '')

    return { value: { isAnswered: true, text: verdicts.shift() ?? NONE, usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The engine's own band, drawn when the plugin has nothing to show.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return { sent, systems }
}

async function setGoal($: any, clock: any) {
  await $.session.start({ cwd: '/proj', surface: 'vscode', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__hack-users-for-llms__set_goal',
    destination: '이탈 분석 보고서',
    done: '원인 3개와 근거',
    avoid: '디자인 논의',
    steps: 4,
  })
  await $.turn.complete(turnEnd(0, '목표를 저장했어요'))
  await clock.advance(10)
}

async function turn($: any, clock: any, n: number, prompt: string) {
  await $.prompt.submit({ text: prompt })
  await $.turn.complete(turnEnd(n, '답변'))
  await clock.advance(10)
}

const config = (hook: Record<string, unknown>) => ({
  '/proj/.criteria/config.json': JSON.stringify({ hook }),
})

test('no goal: no judge call, no question, no session note', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, {}, [CHOICE])
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.systems.length).toBe(0)
  expect(eng.sent[0]?.context.length).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('with a goal, one judge call moves the board and asks; an option answers it', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, {}, [CHOICE])
  await setGoal($, clock)
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.systems.length).toBe(1)
  expect(eng.sent.at(-1)?.context.join('')).toContain('[compass]')

  for (const surface of ['terminal', 'vscode', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /가입자인가요/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /사용자 이탈 원인을 정리해줘/ })).toBeTruthy()
    expect(await ui.find({ key: 'gap-opt-1' })).toBeTruthy()
    expect(await ui.find({ key: 'gap-unknown' })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'gap-free' })).toBeTruthy()
  await ui.press({ key: 'gap-opt-1' })
  await ui.unmount()

  const answer = eng.sent.find(s => s.text.startsWith('[compass 점검 답변]'))?.text ?? ''
  expect(answer).toContain('점검 종류: 구분')
  expect(answer).toContain('내 답: 결제 고객')
  expect(answer).toContain('근거로 본 내 말: "사용자 이탈 원인을 정리해줘"')

  const after = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await after.find({ type: 'Text', text: /가입자인가요/ })).toBeFalsy()
  await after.unmount()
})

test('a free-text question is answered in the field', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, {}, [FREE])
  await setGoal($, clock)
  await turn($, clock, 1, '매거진 기획해줘')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'gap-opt-0' })).toBeFalsy()
  await ui.input({ key: 'gap-free', text: '처음 육아하는 30대 부모' })
  await ui.unmount()

  expect(eng.sent.at(-1)?.text).toContain('내 답: 처음 육아하는 30대 부모')
  expect(eng.sent.at(-1)?.text).toContain('점검 종류: 생략된 전제')
})

test('cooldown and the session cap from the criteria config hold', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, config({ intensity: 'active', max_per_session: 2, cooldown_turns: 1 }), [
    CHOICE,
    CHOICE,
    FREE,
    CHOICE,
    CHOICE,
  ])
  await setGoal($, clock)
  const canAsk = () => !eng.systems.at(-1)?.includes('이번 턴은 묻지 않는다')

  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(canAsk()).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'gap-skip' })
  await ui.unmount()

  await turn($, clock, 2, '다음 단계로 가자')
  expect(canAsk()).toBe(false)
  await turn($, clock, 3, '매거진 기획해줘')
  expect(canAsk()).toBe(true)
  const second = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await second.press({ key: 'gap-skip' })
  await second.unmount()

  await turn($, clock, 4, '계속')
  await turn($, clock, 5, '계속')
  expect(canAsk()).toBe(false)
  expect(eng.systems.length).toBe(5)
})

test('a verdict without the user quote asks nothing; an unanswered question expires', async ($, on) => {
  const clock = mock.clock(on)
  const noQuote = JSON.stringify({ ...JSON.parse(FREE), quote: '' })
  engine(on, config({ cooldown_turns: 0 }), [noQuote, FREE])
  await setGoal($, clock)
  await turn($, clock, 1, '매거진 기획해줘')
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'gap-free' })).toBeFalsy()
  await ui.unmount()

  await turn($, clock, 2, '매거진 기획해줘')
  const asked = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await asked.find({ key: 'gap-free' })).toBeTruthy()
  await asked.unmount()

  for (const n of [3, 4, 5]) await turn($, clock, n, '계속 진행해줘')
  const gone = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await gone.find({ key: 'gap-free' })).toBeFalsy()
  await gone.unmount()
})

test('a broken config reads as the defaults', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, { '/proj/.criteria/config.json': '{not json' }, [CHOICE])
  await setGoal($, clock)
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.systems.at(-1)).toContain('애매하면 묻지 않는다')
})
