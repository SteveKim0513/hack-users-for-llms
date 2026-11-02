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

type Call = { model: string; system: string }

// Stands for the engine beneath the plugin: a project at /proj, HOME at /home, files
// from `files`, a store holding `mode` for /proj, the judge answering from `verdicts`.
type DiaryOpts = { isOn?: boolean; isTodayWritten?: boolean; isOnRefused?: boolean }

function engine(on: On, opts: { mode?: string; files?: Record<string, string>; verdicts?: string[]; diary?: DiaryOpts }) {
  const files = opts.files ?? {}
  const verdicts = [...(opts.verdicts ?? [])]
  const store: Record<string, unknown> = opts.mode ? { 'mode:/proj': opts.mode } : {}
  const sent: { text: string; context: readonly string[] }[] = []
  const calls: Call[] = []
  const diary = { isOn: false, isTodayWritten: false, ...opts.diary }
  const diaryRuns: string[] = []
  on('process.run', (_, e) => {
    const args = e.argv.slice(2)
    const result = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args[0] === 'status') return result(JSON.stringify({ on: diary.isOn, today_written: diary.isTodayWritten }))
    diaryRuns.push(args.join(' '))
    if (args[0] === 'on') {
      if (opts.diary?.isOnRefused) return result('자동 실행은 지금 macOS에서만 켤 수 있다.', 2)
      diary.isOn = true
    }
    if (args[0] === 'off') diary.isOn = false
    if (args[0] === 'write') diary.isTodayWritten = true

    return result('썼다: 일기')
  })
  mock.env(on, { HOME: '/home' })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__hack-users-for-llms__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({
    value: Object.keys(files).some(p => p === e.path || p.startsWith(`${e.path}/`)),
  }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('model.complete', (_, e) => {
    calls.push({ model: e.model, system: e.system ?? '' })

    return { value: { isAnswered: true, text: verdicts.shift() ?? NONE, usage: USAGE } }
  })
  on('prompt.submit', (_, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('command.run', () => ({ text: 'engine' }))
  // The engine's own band, drawn when the plugin has nothing to show.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return { sent, calls, store, diaryRuns }
}

const asks = (c: Call | undefined) => !!c?.system.includes('## 빈 곳 점검')

async function start($: any) {
  await $.session.start({ cwd: '/proj', surface: 'vscode', isInteractive: true })
}

async function turn($: any, clock: any, n: number, prompt: string) {
  await $.prompt.submit({ text: prompt })
  await $.turn.complete(turnEnd(n, '답변'))
  await clock.advance(10)
}

const run = ($: any, command: string, args = '') => $.command.run({ command, args })

async function setGoal($: any, clock: any) {
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

test('turning the diary on asks about today; agreeing writes it, from the band', async ($, on) => {
  const eng = engine(on, {})
  await start($)
  await run($, 'hack-mode')
  const picker = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await picker.find({ type: 'Text', text: /세션 일기: 꺼짐/ })).toBeTruthy()
  await picker.press({ key: 'diary-on' })
  await picker.unmount()
  expect(eng.diaryRuns).toEqual(['on'])

  const card = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await card.find({ type: 'Text', text: /현재 시점으로 오늘 일기를 쓸까요/ })).toBeTruthy()
  expect(await card.find({ type: 'Text', text: /이것으로 마무리돼요/ })).toBeTruthy()
  await card.press({ key: 'diary-write' })
  await card.unmount()
  expect(eng.diaryRuns).toEqual(['on', 'write --force'])

  const after = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await after.find({ key: 'diary-write' })).toBeFalsy()
  await after.unmount()
})

test('saying no leaves it to midnight and writes nothing', async ($, on) => {
  const eng = engine(on, {})
  await start($)
  await run($, 'hack-mode')
  const picker = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await picker.press({ key: 'diary-on' })
  await picker.unmount()

  const card = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await card.find({ type: 'Text', text: /안 쓰면 자정에 하루 전체로/ })).toBeTruthy()
  await card.press({ key: 'diary-later' })
  await card.unmount()
  expect(eng.diaryRuns).toEqual(['on'])
})

test('/session-diary-now warns that the earlier diary is discarded when one exists', async ($, on) => {
  const eng = engine(on, { diary: { isOn: true, isTodayWritten: true } })
  await start($)
  await run($, 'session-diary-now')
  const card = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await card.find({ type: 'Text', text: /다시 쓸까요/ })).toBeTruthy()
  expect(await card.find({ type: 'Text', text: /폐기/ })).toBeTruthy()
  await card.press({ key: 'diary-write' })
  await card.unmount()
  expect(eng.diaryRuns).toEqual(['write --force'])
})

test('a refused turn-on asks nothing; the diary can be turned off from the picker', async ($, on) => {
  const refused = engine(on, { diary: { isOnRefused: true } })
  await start($)
  await run($, 'hack-mode')
  const picker = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await picker.press({ key: 'diary-on' })
  expect(await picker.find({ key: 'diary-write' })).toBeFalsy()
  await picker.unmount()
  expect(refused.diaryRuns).toEqual(['on'])
})

test('the picker turns a running diary off', async ($, on) => {
  const eng = engine(on, { diary: { isOn: true } })
  await start($)
  await run($, 'hack-mode')
  const picker = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await picker.find({ type: 'Text', text: /세션 일기: 켜짐/ })).toBeTruthy()
  await picker.press({ key: 'diary-off' })
  await picker.unmount()
  expect(eng.diaryRuns).toEqual(['off'])
})

test('off by default: no judge call, no note, and the commands say how to turn on', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, { verdicts: [CHOICE] })
  await start($)
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.calls.length).toBe(0)
  expect(eng.sent[0]?.context.length).toBe(0)
  expect((await run($, 'compass')).text).toContain('/hack-mode')
  expect((await run($, 'criteria-check')).text).toContain('/hack-mode')

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('/hack-mode shows the picker; a pick is kept for this project', async ($, on) => {
  const eng = engine(on, {})
  await start($)
  await run($, 'hack-mode')

  for (const surface of ['terminal', 'vscode', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /hack-mode · 지금: 끄기/ })).toBeTruthy()
    expect(await ui.find({ key: 'mode-both' })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'mode-criteria' })
  await ui.unmount()
  expect(eng.store['mode:/proj']).toBe('criteria')

  const after = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await after.find({ key: 'mode-both' })).toBeFalsy()
  await after.unmount()
})

test('criteria only: no goal needed; a choice question appears and an option answers it', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, { mode: 'criteria', verdicts: [CHOICE] })
  await start($)
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.calls.map(c => c.model)).toEqual(['sonnet'])
  expect(asks(eng.calls[0])).toBe(true)
  expect(eng.calls[0]?.system).not.toContain('## 진척 판정')
  expect(eng.sent.at(-1)?.context.join('')).toContain('[hack-mode]')

  for (const surface of ['terminal', 'vscode', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /가입자인가요/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /사용자 이탈 원인을 정리해줘/ })).toBeTruthy()
    expect(await ui.find({ key: 'gap-opt-1' })).toBeTruthy()
    expect(await ui.find({ key: 'gap-unknown' })).toBeTruthy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'gap-opt-1' })
  await ui.unmount()
  const answer = eng.sent.find(s => s.text.startsWith('[criteria 점검 답변]'))?.text ?? ''
  expect(answer).toContain('점검 종류: 구분')
  expect(answer).toContain('내 답: 결제 고객')
  expect(answer).toContain('근거로 본 내 말: "사용자 이탈 원인을 정리해줘"')
})

test('compass only: progress on the light model, no question, no note', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, { mode: 'compass', verdicts: [CHOICE] })
  await start($)
  await setGoal($, clock)
  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect(eng.calls.map(c => c.model)).toEqual(['haiku'])
  expect(asks(eng.calls[0])).toBe(false)
  expect(eng.sent.at(-1)?.context.length).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ key: 'gap-free' })).toBeFalsy()
  await ui.unmount()
})

test('both: one call judges progress and asks against the goal; the field answers it', async ($, on) => {
  const clock = mock.clock(on)
  const eng = engine(on, { mode: 'both', verdicts: [FREE] })
  await start($)
  await setGoal($, clock)
  await turn($, clock, 1, '매거진 기획해줘')
  expect(eng.calls.length).toBe(1)
  expect(eng.calls[0]?.model).toBe('sonnet')
  expect(eng.calls[0]?.system).toContain('## 진척 판정')
  expect(eng.calls[0]?.system).toContain('목표와 "다 됐다"의 기준에 비추어')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'gap-opt-0' })).toBeFalsy()
  await ui.input({ key: 'gap-free', text: '처음 육아하는 30대 부모' })
  await ui.unmount()
  expect(eng.sent.at(-1)?.text).toContain('내 답: 처음 육아하는 30대 부모')
  expect(eng.sent.at(-1)?.text).toContain('점검 종류: 생략된 전제')
})

test('cooldown and the session cap from the criteria config hold', async ($, on) => {
  const clock = mock.clock(on)
  const config = { '/proj/.criteria/config.json': JSON.stringify({ hook: { max_per_session: 2, cooldown_turns: 1 } }) }
  const eng = engine(on, { mode: 'criteria', files: config, verdicts: [CHOICE, FREE] })
  await start($)

  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await ui.press({ key: 'gap-skip' })
  await ui.unmount()
  await turn($, clock, 2, '다음 단계로 가자')
  await turn($, clock, 3, '매거진 기획해줘')
  const second = await $.ui.mount({ ...BAND, surface: 'vscode' })
  await second.press({ key: 'gap-skip' })
  await second.unmount()
  await turn($, clock, 4, '계속')
  await turn($, clock, 5, '계속')
  // criteria only: a turn with nothing to ask makes no call at all.
  expect(eng.calls.length).toBe(2)
})

test('a verdict without the user quote asks nothing; an unanswered question expires', async ($, on) => {
  const clock = mock.clock(on)
  const noQuote = JSON.stringify({ ...JSON.parse(FREE), quote: '' })
  const config = { '/proj/.criteria/config.json': JSON.stringify({ hook: { cooldown_turns: 0 } }) }
  engine(on, { mode: 'criteria', files: config, verdicts: [noQuote, FREE] })
  await start($)
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

test('/criteria-check asks now, past the cooldown', async ($, on) => {
  const clock = mock.clock(on)
  const config = { '/proj/.criteria/config.json': JSON.stringify({ hook: { cooldown_turns: 5 } }) }
  const eng = engine(on, { mode: 'criteria', files: config, verdicts: [NONE, CHOICE] })
  await start($)
  expect((await run($, 'criteria-check')).text).toContain('아직 점검할 턴이 없어요')

  await turn($, clock, 1, '사용자 이탈 원인을 정리해줘')
  expect((await run($, 'criteria-check')).text).toContain('질문을 띄웠어요')
  expect(eng.calls.length).toBe(2)

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /가입자인가요/ })).toBeTruthy()
  await ui.unmount()
})
