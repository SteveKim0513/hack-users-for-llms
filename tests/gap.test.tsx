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

const ASK_CHOICE = JSON.stringify({
  ask: true,
  kind: 'distinction',
  question: '여기서 말한 "사용자"는 가입자인가요, 결제 고객인가요?',
  options: ['가입자', '결제 고객'],
  quote: '사용자 이탈 원인을 정리해줘',
  why: '대상에 따라 분석이 달라짐',
})

const ASK_FREE = JSON.stringify({
  ask: true,
  kind: 'premise',
  question: '이 기획은 어떤 독자를 전제로 하나요?',
  options: [],
  quote: '매거진 기획해줘',
  why: '독자 전제가 빠짐',
})

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
  const sent: string[] = []
  let judged = 0
  mock.env(on, { HOME: '/home' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_, e) => ({
    value: Object.keys(files).some(p => p === e.path || p.startsWith(`${e.path}/`)),
  }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: text }
  })
  on('model.complete', () => {
    judged += 1

    return { value: { isAnswered: true, text: verdicts.shift() ?? '{"ask":false}', usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)

    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The engine's own band, drawn when the plugin has nothing to ask.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return { sent, judged: () => judged }
}

const config = (hook: Record<string, unknown>) => ({
  '/proj/.criteria/config.json': JSON.stringify({ hook }),
})

async function turn($: any, clock: any, n: number, prompt: string) {
  await $.prompt.submit({ text: prompt })
  await $.turn.complete(turnEnd(n, '답변'))
  await clock.advance(10)
}

test('off by default: no judge call, nothing drawn', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, {}, [ASK_CHOICE])
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.judged()).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('a choice question appears and an option answers it, on every surface', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, config({ enabled: true, intensity: 'active' }), [ASK_CHOICE])
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.judged()).toBe(1)

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

  const answer = eng.sent.find(t => t.startsWith('[criteria-gap 점검 답변]')) ?? ''
  expect(answer).toContain('점검 종류: 구분')
  expect(answer).toContain('내 답: 결제 고객')
  expect(answer).toContain('근거로 본 내 말: "사용자 이탈 원인을 정리해줘"')

  const after = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await after.find({ type: 'Text', text: /가입자인가요/ })).toBeFalsy()
  await after.unmount()
})

test('a free-text question is answered in the field', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, config({ enabled: true, intensity: 'active' }), [ASK_FREE])
  await turn($, clock, 1, '매거진 기획해줘')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'gap-opt-0' })).toBeFalsy()
  await ui.input({ key: 'gap-free', text: '처음 육아하는 30대 부모' })
  await ui.unmount()

  expect(eng.sent.at(-1)).toContain('내 답: 처음 육아하는 30대 부모')
  expect(eng.sent.at(-1)).toContain('점검 종류: 생략된 전제')
})

test('the answer turn itself is not judged; cooldown and the session cap hold', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, config({ enabled: true, intensity: 'active', max_per_session: 2, cooldown_turns: 1 }), [
    ASK_CHOICE,
    ASK_FREE,
    ASK_CHOICE,
  ])
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.judged()).toBe(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'gap-skip' })
  await ui.unmount()

  await turn($, clock, 2, '그럼 다음 단계로 가자')
  expect(eng.judged()).toBe(1)
  await turn($, clock, 3, '매거진 기획해줘')
  expect(eng.judged()).toBe(2)

  await ($ as any).prompt.submit({ text: '[criteria-gap 점검 답변]\n내 답: 모름' })
  await $.turn.complete(turnEnd(4, '후보를 드릴게요'))
  await clock.advance(10)
  await turn($, clock, 5, '다른 것도 기획해줘')
  await turn($, clock, 6, '또 다른 것도 기획해줘')
  expect(eng.judged()).toBe(2)
})

test('a verdict without the user quote asks nothing; an unanswered question expires', async ($, on) => {
  const clock = mock.clock(on)
  const noQuote = JSON.stringify({ ...JSON.parse(ASK_FREE), quote: '' })
  const eng = engine(on, config({ enabled: true, intensity: 'active', cooldown_turns: 0 }), [noQuote, ASK_FREE])
  await turn($, clock, 1, '매거진 기획해줘')
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'gap-free' })).toBeFalsy()
  await ui.unmount()

  await turn($, clock, 2, '매거진 기획해줘')
  expect(eng.judged()).toBe(2)
  const asked = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await asked.find({ key: 'gap-free' })).toBeTruthy()
  await asked.unmount()

  for (const n of [3, 4, 5]) await turn($, clock, n, '계속 진행해줘')
  const gone = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await gone.find({ key: 'gap-free' })).toBeFalsy()
  await gone.unmount()
})

test('a broken project config reads as off, even with the global one on', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(
    on,
    {
      '/proj/.criteria/config.json': '{not json',
      '/home/.criteria/config.json': JSON.stringify({ hook: { enabled: true } }),
    },
    [],
  )
  await turn($, clock, 1, '매거진 기획해줘')
  expect(eng.judged()).toBe(0)
})

test('the global config applies when the project has none', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, { '/home/.criteria/config.json': JSON.stringify({ hook: { enabled: true } }) }, [])
  await turn($, clock, 1, '매거진 기획해줘')
  expect(eng.judged()).toBe(1)
})
