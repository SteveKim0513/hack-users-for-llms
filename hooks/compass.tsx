import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Compass, GapKind, GapQuestion, Goal, Proposal, Step, StepKind } from '../types'

// /compass: 대화 목표를 정하면 턴마다 판정 한 번으로 두 가지를 한다.
//   1. 목표까지의 진척을 패널의 LED 판에 찍는다.
//   2. 사용자 생각에 빈 곳(생략된 전제, 섞인 구분, 원리 이해, 빠진 판단 기준)이 보이면 입력창 위에 질문 하나를 띄운다.
// 질문의 강도, 세션당 횟수, 쉬는 턴은 criteria-init이 쓰는 .criteria/config.json의 hook에서 읽는다(없으면 기본값).

const PLUGIN = 'hack-users-for-llms'
const PANE = 'compass'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`
const MAX_ROWS = 12
const JUDGE_MODEL = 'sonnet'
// 답하지 않은 질문은 이만큼 턴이 지나면 내린다.
const EXPIRE_TURNS = 3
const ANSWER_TAG = '[compass 점검 답변]'

const EMPTY: Compass = {
  goal: null,
  steps: [],
  segments: [],
  proposal: null,
  isJudging: false,
  turn: 0,
  note: '',
  question: null,
  asked: 0,
  lastAskTurn: -999,
}

// Bump the tag when Compass changes shape: older stored values read as EMPTY.
const compass = atom({ plugin: 'hack-users-for-llms', key: 'compass' } as const, EMPTY, {
  shape: 'compass-2',
})

const COLORS: Record<StepKind, string> = {
  start: '#cfd8dc',
  up: '#39e67a',
  flat: '#ffb627',
  down: '#ff4b4b',
  pivot: '#4da3ff',
  arrive: '#ffd700',
}

const ARROWS: Record<StepKind, string> = {
  start: '●',
  up: '▲',
  flat: '▶',
  down: '▼',
  pivot: '↺',
  arrive: '★',
}

const clampRows = (n: unknown) =>
  Math.max(1, Math.min(MAX_ROWS, Math.round(Number(n) || 5)))

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text

const str = (v: unknown, fallback = '') =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback

type Config = {
  intensity: 'light' | 'active'
  max_per_session: number
  cooldown_turns: number
}

const DEFAULTS: Config = { intensity: 'light', max_per_session: 3, cooldown_turns: 3 }

const KINDS: GapKind[] = ['premise', 'distinction', 'principle', 'criterion']

const KIND_LABEL: Record<GapKind, string> = {
  premise: '생략된 전제',
  distinction: '구분',
  principle: '원리 이해',
  criterion: '판단 기준',
}

const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

// ---------- 질문 설정과 기록소 (hooks/criteria_hook.py와 같은 규칙) ----------

type Dirs = { project: string | null; global: string | null }

async function criteriaDirs($: EngineInterface): Promise<Dirs> {
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  let dir = (await $.session.cwd()).replace(/\/+$/, '') || '/'
  let project: string | null = null
  for (let i = 0; i < 64; i++) {
    if (await $.fs.exists(`${dir}/.criteria`)) {
      project = `${dir}/.criteria`
      break
    }
    if (dir === home || dir === '/') break
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
  const global = home && (await $.fs.exists(`${home}/.criteria`)) ? `${home}/.criteria` : null

  return { project, global }
}

// 프로젝트 설정이 있으면 그것, 없으면 전역. 깨진 설정은 기본값으로 본다.
async function loadConfig($: EngineInterface, dirs: Dirs): Promise<Config> {
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir || !(await $.fs.exists(`${dir}/config.json`))) continue
    try {
      const raw = JSON.parse(await $.fs.read(`${dir}/config.json`))?.hook ?? {}

      return {
        intensity: raw.intensity === 'active' ? 'active' : 'light',
        max_per_session: Number.isFinite(raw.max_per_session) ? raw.max_per_session : DEFAULTS.max_per_session,
        cooldown_turns: Number.isFinite(raw.cooldown_turns) ? raw.cooldown_turns : DEFAULTS.cooldown_turns,
      }
    } catch {
      return DEFAULTS
    }
  }

  return DEFAULTS
}

// 판정 모델이 이미 정한 것을 다시 묻지 않도록 확정 기준 요약만 넘긴다.
async function confirmedIndex($: EngineInterface, dirs: Dirs): Promise<string[]> {
  const lines: string[] = []
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir || !(await $.fs.exists(`${dir}/INDEX.md`))) continue
    try {
      const text = await $.fs.read(`${dir}/INDEX.md`)
      lines.push(...text.split('\n').filter(l => l.includes('· confirmed ·')))
    } catch {
      // INDEX.md가 없으면 넘어간다.
    }
  }

  return lines.slice(0, 15).map(l => clip(l.trim(), 200))
}

// 판정 JSON의 질문 부분. 사용자 발화 인용이 없으면 묻지 않는다.
const parseQuestion = (raw: Record<string, unknown>, turn: number): GapQuestion | null => {
  try {
    const kind = KINDS.find(k => k === raw.kind)
    const question = oneLine(raw.question)
    const quote = oneLine(raw.quote)
    if (raw.ask !== true || !kind || !question || !quote) return null
    const options = Array.isArray(raw.options)
      ? [...new Set(raw.options.map(o => oneLine(o)).filter(Boolean))].slice(0, 4).map(o => clip(o, 40))
      : []

    return {
      kind,
      question: clip(question, 160),
      options,
      quote: clip(quote, 80),
      why: clip(oneLine(raw.why), 60),
      turn,
    }
  } catch {
    return null
  }
}

const answerPrompt = (q: GapQuestion, answer: string) =>
  [
    ANSWER_TAG,
    `점검 종류: ${KIND_LABEL[q.kind]}`,
    `질문: ${q.question}`,
    q.options.length ? `보기: ${q.options.join(' / ')}` : '',
    `근거로 본 내 말: "${q.quote}"`,
    `내 답: ${answer}`,
    '이 답은 /compass의 빈 곳 점검에서 왔다. 다루는 법은 criteria-gap 스킬의 "compass 점검 답변" 절에 있다.',
  ]
    .filter(Boolean)
    .join('\n')

// 목표가 있는 동안 매 요청에 붙는 사실 한 줄. [criteria 훅]의 "기준을 묻는다" 규칙과 겹치지 않게 한다.
const SESSION_NOTE =
  '[compass] 이 세션은 /compass 목표가 정해져 있다. 빠진 기준과 전제는 compass가 턴이 끝난 뒤 입력창 위에서 사용자에게 묻고, 답은 "[compass 점검 답변]" 메시지로 들어온다. 그래서 이 세션에서 기준을 묻는 일은 compass가 맡는다.'

// ---------- prompts ----------

const interviewPrompt = (seed: string) =>
  [
    '[compass] 이 대화의 목표 지점을 정하는 인터뷰를 시작해 주세요.',
    seed ? `사용자가 처음 꺼낸 생각: "${seed}"` : '',
    '',
    '규칙:',
    '- 한 번에 질문 하나만 하고, 답을 들은 뒤 다음 질문으로 넘어가세요.',
    '- 알아낼 것: (1) 도착점: 이 대화가 끝났을 때 손에 쥐고 있어야 할 것, (2) "다 됐다"의 기준: 확인할 수 있는 조건, (3) 하지 말 것: 범위 밖이거나 피하고 싶은 길, (4) 도착까지 대략 몇 걸음(턴)이 필요할지 (1~12).',
    '- 답이 모호하면 구체적인 예를 들어 다시 물어 좁히세요. 가능하면 추천안을 함께 주세요.',
    '- 네 가지가 모이면 목표 카드를 짧게 보여 주고 확인을 받으세요.',
    `- 사용자가 확인하면 ${TOOL('set_goal')} 도구를 호출해 카드를 저장하세요. 확인 전에는 호출하지 마세요.`,
  ]
    .filter(Boolean)
    .join('\n')

const changePrompt = (goal: Goal, ask: string) =>
  [
    '[compass] 사용자가 목표를 고치고 싶어 합니다.',
    `지금 목표: ${goal.destination} (다 됐다: ${goal.done} / 하지 말 것: ${goal.avoid} / ${goal.rows}걸음)`,
    `사용자의 말: "${ask}"`,
    '',
    '먼저 이것이 어떤 변경인지 사용자와 확인하세요.',
    `- 같은 방향에서 목표가 높아지거나 낮아지는 것(걸음 수만 바뀜): 확인 후 ${TOOL('adjust_goal_height')} 호출.`,
    `- 목표의 방향 자체가 바뀌는 것: 새 목표 카드를 정리하고, 지금까지 한 일 중 새 목표에도 쓸모 있는 걸음 수(carry)를 추정해 ${TOOL('propose_goal_change')} 호출. 반영은 사용자가 패널의 버튼으로 확정해야 된다고 안내하세요.`,
  ].join('\n')

const RULE: Record<Config['intensity'], string> = {
  light: '- 답이 없으면 다음 작업이 틀어지거나 사용자가 잘못 결정할 것이 분명할 때만 묻는다. 애매하면 묻지 않는다.',
  active: '- 위 네 가지 중 하나가 분명히 보이고 답에 따라 결과가 달라지면 묻는다.',
}

const judgeSystem = (intensity: Config['intensity'], canAsk: boolean) => `당신은 대화 여정 판정관입니다. 사람과 AI의 대화가 정해진 목표 지점을 향해 가고 있는지 방금 끝난 한 턴만 보고 판정하고, 사용자의 생각에 빈 곳이 있으면 물을 질문 하나를 고릅니다.

## 진척 판정
- "up": 이 턴이 목표에 실질적으로 한 걸음 가까워지게 했다 (결정이 내려짐, 산출물이 진척됨, 막힌 문제가 풀림).
- "flat": 제자리이거나 옆길이다 (확인만 함, 목표와 무관한 논의, 같은 얘기 반복).
- "down": 목표에서 멀어졌다 (하지 말 것을 함, 잘못된 방향으로 만든 것을 되돌려야 함, 혼란이 커짐).
- done: "다 됐다"의 기준을 이번 턴으로 충족했으면 true.
- pivot: 사용자가 목표 자체를 다른 방향으로 바꾸려는 신호가 분명하면 true. 단순히 AI가 옆길로 샌 것은 pivot이 아니라 flat/down이다.
- pivot이 true면 new_destination(새 도착점 한 문장)과 carry(지금까지 한 일 중 새 목표에도 쓸모 있는 걸음 수, 0 이상)를 채운다.

## 빈 곳 점검
${canAsk ? GAP_RULES(intensity) : '이번 턴은 묻지 않는다. ask는 false로 둔다.'}

JSON 한 개만 출력합니다. 다른 말은 쓰지 않습니다.
{"move":"up|flat|down","reason":"40자 이내 한국어 한 줄","done":false,"pivot":false,"new_destination":"","carry":0,"ask":false,"kind":"premise|distinction|principle|criterion","question":"","options":[],"quote":"근거가 된 사용자 발화, 60자 이내","why":"지금 묻는 이유, 40자 이내"}`

const GAP_RULES = (intensity: Config['intensity']) => `AI가 아니라 사용자의 생각을 점검합니다. 목표와 "다 됐다"의 기준에 비추어 봅니다.

볼 것(kind):
- "premise" 생략된 전제: 사용자의 요청이 말하지 않은 가정에 기대고 있고, AI가 그 가정을 임의로 채웠다.
- "distinction" 구분: 사용자가 서로 다른 두 가지를 한 말로 섞었거나, 어느 쪽인지 가르지 않아 결과가 달라진다.
- "principle" 원리 이해: 사용자가 어떤 판단이나 결정을 내리거나 받아들였는데, 그 바탕 원리를 이해했다면 바로 답할 수 있는 질문으로 이해를 확인할 가치가 있다.
- "criterion" 판단 기준: 사용자가 기준 없이 고르기, 거르기, 평가를 맡겼고 AI가 암묵 기준으로 처리했다.

묻는 조건:
- 근거가 되는 사용자 발화를 그대로 짧게 인용할 수 있어야 한다. 인용할 수 없으면 묻지 않는다.
- 답에 따라 다음 작업이나 사용자의 결정이 달라져야 한다. 사소하면 묻지 않는다.
${RULE[intensity]}
- 확정 기준 목록으로 답이 나오는 것은 묻지 않는다.
- 인사, 감사, 단순 확인, 진행 지시("응", "계속")만 있는 턴에서는 묻지 않는다.

질문 쓰는 법:
- 질문 하나. 한국어 존댓말, 120자 이내. 사용자가 자기 말로 답할 수 있게 구체적으로.
- AI의 답이나 AI가 쓴 기준을 질문에 드러내지 않는다. 사용자가 먼저 자기 생각을 말해야 한다.
- options: 객관식이 맞으면 서로 겹치지 않는 선택지 2~4개(각 40자 이내). "principle"과 "distinction"은 보통 객관식, "premise"와 "criterion"은 보통 주관식이라 비운다. "모름"은 넣지 않는다(화면에 따로 있다).

`

const judgePrompt = (c: Compass, turn: TurnSnapshot, known: string[]) => {
  const goal = c.goal as Goal
  const here = c.steps[c.steps.length - 1]
  const recent = c.steps
    .slice(-6)
    .map(s => `T${s.turn} ${s.kind}: ${s.reason}`)
    .join('\n')

  return [
    `목표 도착점: ${goal.destination}`,
    `다 됐다의 기준: ${goal.done}`,
    `하지 말 것: ${goal.avoid}`,
    `현재 높이: ${here?.height ?? 0} / ${goal.rows}`,
    '',
    '최근 경로:',
    recent || '(없음)',
    '',
    '확정 기준:',
    known.length ? known.join('\n') : '(없음)',
    '',
    `이번 턴 사용자 메시지:\n${clip(turn.prompt || '(없음)', 2500)}`,
    '',
    `이번 턴 AI 답변:\n${clip(turn.answer || '(없음)', 3500)}`,
    turn.tools.length ? `\n이번 턴에 쓴 도구: ${turn.tools.slice(0, 30).join(', ')}` : '',
  ].join('\n')
}

// ---------- state changes ----------

type TurnSnapshot = { turn: number; prompt: string; answer: string; tools: string[] }

type Verdict = {
  question: GapQuestion | null
  move: 'up' | 'flat' | 'down'
  reason: string
  done: boolean
  pivot: boolean
  newDestination: string
  carry: number
}

const parseVerdict = (text: string, turn: number): Verdict | null => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const move = raw.move === 'up' || raw.move === 'down' ? raw.move : 'flat'

    return {
      question: parseQuestion(raw, turn),
      move,
      reason: clip(str(raw.reason, '이유 없음'), 60),
      done: raw.done === true,
      pivot: raw.pivot === true,
      newDestination: str(raw.new_destination),
      carry: Math.max(0, Math.round(Number(raw.carry) || 0)),
    }
  } catch {
    return null
  }
}

const currentSegment = (c: Compass) => Math.max(0, c.segments.length - 1)

const applyVerdict = (c: Compass, turn: number, v: Verdict): Compass => {
  if (!c.goal) return c
  const last = c.steps[c.steps.length - 1]
  const height = last?.height ?? 0
  const rows = c.goal.rows
  let next = v.move === 'up' ? height + 1 : v.move === 'down' ? height - 1 : height
  next = Math.max(0, Math.min(rows, next))
  let kind: StepKind = v.move
  if (v.done || next >= rows) {
    next = rows
    kind = 'arrive'
  }
  const step: Step = { kind, height: next, segment: currentSegment(c), turn, reason: v.reason }
  const proposal: Proposal | null =
    c.proposal ??
    (v.pivot && v.newDestination
      ? {
          destination: v.newDestination,
          done: c.goal.done,
          avoid: c.goal.avoid,
          rows,
          carry: Math.min(rows, v.carry),
          reason: v.reason,
          from: 'judge',
        }
      : null)

  return { ...c, steps: [...c.steps, step].slice(-300), proposal }
}

const confirmProposal = (c: Compass): Compass => {
  const p = c.proposal
  if (!p || !c.goal) return { ...c, proposal: null }
  const goal: Goal = { destination: p.destination, done: p.done, avoid: p.avoid, rows: p.rows }
  const segment = c.segments.length
  const step: Step = {
    kind: 'pivot',
    height: Math.min(p.rows, p.carry),
    segment,
    turn: c.turn,
    reason: `목표 전환: ${clip(p.destination, 40)}`,
  }

  return {
    ...c,
    goal,
    segments: [...c.segments, { destination: p.destination, rows: p.rows }],
    steps: [...c.steps, step],
    proposal: null,
    note: `방향 전환 확정 (T${c.turn})`,
  }
}

// ---------- drawing ----------

const ledSvg = (c: Compass, maxCols: number): string => {
  const rows = c.goal?.rows ?? 5
  const cell = 16
  const pad = 10
  const steps = c.steps.slice(-maxCols)
  const cols = Math.max(steps.length, Math.min(maxCols, 12))
  const width = pad * 2 + cols * cell
  const height = pad * 2 + (rows + 1) * cell + 10
  const seg = currentSegment(c)
  const y = (h: number) => pad + (rows - Math.min(h, rows)) * cell + cell / 2
  const x = (i: number) => pad + i * cell + cell / 2
  const parts: string[] = []

  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#0d0f12"/>`)
  for (let i = 0; i < cols; i++) {
    for (let level = 0; level <= rows; level++) {
      const isGoalRow = level === rows
      parts.push(
        `<circle cx="${x(i)}" cy="${y(level)}" r="4.5" fill="${isGoalRow ? '#3b3317' : '#1f242b'}"/>`,
      )
    }
  }
  steps.forEach((s, i) => {
    if (s.kind === 'pivot' && i > 0) {
      const lx = x(i) - cell / 2
      parts.push(
        `<line x1="${lx}" y1="${pad - 2}" x2="${lx}" y2="${pad + (rows + 1) * cell + 2}" stroke="#4da3ff" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/>`,
      )
    }
  })
  steps.forEach((s, i) => {
    const color = COLORS[s.kind]
    const opacity = s.segment === seg ? 1 : 0.3
    const isLast = i === steps.length - 1
    parts.push(
      `<circle cx="${x(i)}" cy="${y(s.height)}" r="7.5" fill="${color}" opacity="${0.22 * opacity}"/>`,
      `<circle cx="${x(i)}" cy="${y(s.height)}" r="4.8" fill="${color}" opacity="${opacity}"/>`,
    )
    if (isLast) {
      parts.push(
        `<circle cx="${x(i)}" cy="${y(s.height)}" r="7.5" fill="none" stroke="${color}" stroke-width="1.5"><animate attributeName="opacity" values="0.15;0.9;0.15" dur="1.6s" repeatCount="indefinite"/></circle>`,
      )
    }
    if (s.turn > 0 && (s.turn % 5 === 0 || isLast)) {
      parts.push(
        `<text x="${x(i)}" y="${height - 4}" font-size="8" fill="#5c6670" text-anchor="middle" font-family="monospace">${s.turn}</text>`,
      )
    }
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

const ledAlt = (c: Compass) => {
  const last = c.steps[c.steps.length - 1]
  if (!c.goal || !last) return '목표가 아직 없어요'

  return `목표까지 ${last.height}/${c.goal.rows}칸, 최근 판정: ${last.reason}`
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: '목표 여정' })
}

async function judge($: EngineInterface, snap: TurnSnapshot) {
  const before = await read($, compass)
  if (!before.goal) return
  await update($, compass, c => ({ ...c, isJudging: true }))
  let cfg = DEFAULTS
  let known: string[] = []
  try {
    const dirs = await criteriaDirs($)
    cfg = await loadConfig($, dirs)
    known = await confirmedIndex($, dirs)
  } catch {
    // 설정을 못 읽으면 기본값으로 판정한다.
  }
  const canAsk =
    !before.question &&
    before.asked < cfg.max_per_session &&
    snap.turn - before.lastAskTurn > cfg.cooldown_turns
  const res = await $.model.complete({
    model: JUDGE_MODEL,
    system: judgeSystem(cfg.intensity, canAsk),
    prompt: judgePrompt(before, snap, known),
    maxTokens: 700,
    effort: 'low',
  })
  const verdict = res.isAnswered ? parseVerdict(res.text, snap.turn) : null
  const after = await update($, compass, c => {
    const done = { ...c, isJudging: false }
    if (!verdict) return { ...done, note: `T${snap.turn} 판정 실패` }
    const next = { ...applyVerdict(done, snap.turn, verdict), note: '' }
    if (!canAsk || !verdict.question || next.question) return next

    return { ...next, question: verdict.question, asked: next.asked + 1, lastAskTurn: snap.turn }
  })
  const last = after.steps[after.steps.length - 1]
  if (last?.kind === 'arrive' && before.steps[before.steps.length - 1]?.kind !== 'arrive') {
    $.ui.toast('🎯 목표에 도착했어요')
  }
}

async function reply($: EngineInterface, answer: string) {
  const q = (await read($, compass)).question
  if (!q || !answer.trim()) return
  await update($, compass, c => ({ ...c, question: null }))
  await $.prompt.submit({ text: answerPrompt(q, answer.trim()) })
}

function questionCard($: EngineInterface, els: Record<string, any>, q: GapQuestion) {
  const { Box, Text, Button } = els
  // 모바일에는 입력칸이 없다. 그때는 보기와 "모름"만 보인다.
  const Input = els.Input

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#c792ea" paddingX={1}>
      <Text bold color="#c792ea">
        🧭 {KIND_LABEL[q.kind]} 점검
      </Text>
      <Text>{q.question}</Text>
      <Text dimColor>근거: "{q.quote}"</Text>
      {q.options.length > 0 && (
        <Box flexDirection="column">
          {q.options.map((o, i) => (
            <Button key={`gap-opt-${i}`} label={o} hotkey={String(i + 1)} onPress={() => reply($, o)} />
          ))}
        </Box>
      )}
      {Input && (
        <Input
          key="gap-free"
          label="직접 답하기"
          placeholder="내 말로 쓰기"
          submitLabel="보내기"
          onSubmit={(v: string) => reply($, v)}
        />
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="gap-unknown" label="모름" onPress={() => reply($, '모름')} />
        <Button key="gap-skip" label="건너뛰기" onPress={() => update($, compass, c => ({ ...c, question: null }))} />
      </Box>
    </Box>
  )
}

function proposalButtons($: EngineInterface, Button: any, Box: any) {
  return (
    <Box flexDirection="row" gap={1}>
      <Button
        key="pivot-yes"
        label="바뀐 게 맞아요"
        variant="primary"
        onPress={() => update($, compass, confirmProposal)}
      />
      <Button
        key="pivot-no"
        label="아니요, 옆길이에요"
        onPress={() => update($, compass, c => ({ ...c, proposal: null }))}
      />
    </Box>
  )
}

// ---------- module ----------

export const register: Register = on => {
  // Turn-local scratch; a reload only loses the turn in progress.
  let prompts: string[] = []
  let tools: string[] = []
  let isSetupTurn = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'compass',
      description: '대화 목표 정하기 · /compass 수정할 내용 · /compass reset · /compass show',
      argumentHint: '[처음 생각 | 수정할 내용 | reset | show]',
    })
    await $.tool.register({
      name: 'set_goal',
      description:
        '대화의 목표 카드를 저장한다. /compass 인터뷰가 끝나고 사용자가 카드를 확인했을 때만 호출한다.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: '도착점: 대화가 끝났을 때 손에 쥐고 있어야 할 것' },
          done: { type: 'string', description: '"다 됐다"를 확인할 수 있는 기준' },
          avoid: { type: 'string', description: '하지 말 것, 범위 밖' },
          steps: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: '도착까지 예상 걸음 수' },
        },
        required: ['destination', 'done', 'avoid', 'steps'],
      },
    })
    await $.tool.register({
      name: 'adjust_goal_height',
      description:
        '같은 방향에서 목표가 높아지거나 낮아질 때 걸음 수만 바꾼다. 사용자가 확인한 뒤에만 호출한다.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
          reason: { type: 'string' },
        },
        required: ['steps', 'reason'],
      },
    })
    await $.tool.register({
      name: 'propose_goal_change',
      description:
        '목표의 방향이 바뀔 때 새 목표 카드를 제안한다. 바로 반영되지 않고, 사용자가 패널의 버튼으로 확정해야 반영된다.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          done: { type: 'string' },
          avoid: { type: 'string' },
          steps: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
          carry: { type: 'integer', minimum: 0, description: '지금까지 한 일 중 새 목표에도 쓸모 있는 걸음 수' },
          reason: { type: 'string' },
        },
        required: ['destination', 'done', 'avoid', 'steps', 'carry', 'reason'],
      },
    })
    const c = await read($, compass)
    if (c.goal) void openPane($)

    return next(e)
  })

  on('command.run', { command: 'compass' }, async ($, e) => {
    const args = e.args.trim()
    const c = await read($, compass)

    if (args === 'reset') {
      await update($, compass, () => EMPTY)

      return { text: '목표와 경로를 지웠어요. /compass 로 새로 시작하세요.' }
    }
    await openPane($)
    if (args === 'show') {
      return { text: c.goal ? `목표: ${c.goal.destination}` : '아직 목표가 없어요.' }
    }
    if (c.goal && args) {
      await $.prompt.submit({ text: changePrompt(c.goal, args) })

      return { text: '목표 수정을 시작해요.' }
    }
    if (c.goal) {
      return {
        text: `지금 목표: ${c.goal.destination}\n수정은 /compass 수정할 내용, 초기화는 /compass reset`,
      }
    }
    await $.prompt.submit({ text: interviewPrompt(args) })

    return { text: '목표 정하기 인터뷰를 시작해요.' }
  })

  on('tool.call', { tool: 'mcp__hack-users-for-llms__set_goal' }, async ($, e) => {
    const c = await read($, compass)
    if (c.goal) {
      return { result: '이미 목표가 있습니다. 높이 변경은 adjust_goal_height, 방향 변경은 propose_goal_change를 쓰세요.' }
    }
    const goal: Goal = {
      destination: str(e.destination, '목표'),
      done: str(e.done, '-'),
      avoid: str(e.avoid, '-'),
      rows: clampRows(e.steps),
    }
    isSetupTurn = true
    await update($, compass, cur => ({
      ...cur,
      goal,
      segments: [{ destination: goal.destination, rows: goal.rows }],
      steps: [{ kind: 'start', height: 0, segment: 0, turn: cur.turn, reason: '출발' } as Step],
      proposal: null,
      note: '',
    }))
    void openPane($)

    return { result: `목표를 저장했습니다. 이제 매 턴 진척이 패널에 표시됩니다. (${goal.rows}걸음)` }
  })

  on('tool.call', { tool: 'mcp__hack-users-for-llms__adjust_goal_height' }, async ($, e) => {
    const c = await read($, compass)
    if (!c.goal) return { result: '목표가 없습니다. 먼저 /compass 로 정하세요.' }
    const rows = clampRows(e.steps)
    isSetupTurn = true
    await update($, compass, cur => {
      if (!cur.goal) return cur
      const segments = cur.segments.map((s, i) =>
        i === cur.segments.length - 1 ? { ...s, rows } : s,
      )

      return {
        ...cur,
        goal: { ...cur.goal, rows },
        segments,
        note: `목표 높이 ${cur.goal.rows} → ${rows}걸음: ${clip(str(e.reason), 40)}`,
      }
    })

    return { result: `목표 높이를 ${rows}걸음으로 바꿨습니다.` }
  })

  on('tool.call', { tool: 'mcp__hack-users-for-llms__propose_goal_change' }, async ($, e) => {
    const c = await read($, compass)
    if (!c.goal) return { result: '목표가 없습니다. 먼저 /compass 로 정하세요.' }
    const rows = clampRows(e.steps)
    const proposal: Proposal = {
      destination: str(e.destination, '새 목표'),
      done: str(e.done, c.goal.done),
      avoid: str(e.avoid, c.goal.avoid),
      rows,
      carry: Math.max(0, Math.min(rows, Math.round(Number(e.carry) || 0))),
      reason: clip(str(e.reason), 60),
      from: 'model',
    }
    isSetupTurn = true
    await update($, compass, cur => ({ ...cur, proposal }))
    void openPane($)

    return {
      result:
        '제안을 패널에 올렸습니다. 사용자가 패널이나 입력창 위의 "바뀐 게 맞아요" 버튼을 눌러야 반영됩니다. 사용자에게 그렇게 안내하세요.',
    }
  })


  on('tool.call', ($, e, next) => {
    tools.push(String(e.tool))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, compass)

    if (!c.goal) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>아직 목표가 없어요</Text>
          <Text dimColor>/compass 을 입력하면 질문을 하나씩 드리면서 이 대화의 도착점을 정해요.</Text>
          <Button
            key="start"
            label="목표 정하기"
            variant="primary"
            onPress={() => $.prompt.submit({ text: interviewPrompt('') })}
          />
        </Box>
      )
    }

    const last = c.steps[c.steps.length - 1]
    const height = last?.height ?? 0
    const seg = currentSegment(c)
    const recent = c.steps.slice(-6).reverse()
    const cols = Math.max(8, Math.min(60, Math.floor(((e.props.bodyColumns || 40) * 7.5 - 20) / 16)))
    let board

    if (e.surface === 'terminal') {
      const view = c.steps.slice(-Math.max(8, (e.props.bodyColumns || 40) - 6))
      const rows = []
      for (let level = c.goal.rows; level >= 0; level--) {
        rows.push(
          <Box key={`r${level}`} flexDirection="row">
            {view.map((s, i) =>
              s.height === level ? (
                <Text color={COLORS[s.kind]} dimColor={s.segment !== seg}>
                  ●
                </Text>
              ) : (
                <Text dimColor>{level === c.goal!.rows ? '○' : '·'}</Text>
              ),
            )}
          </Box>,
        )
      }
      board = <Box flexDirection="column">{rows}</Box>
    } else {
      const { Svg } = $.ui.resolve(e)
      board = <Svg source={ledSvg(c, cols)} alt={ledAlt(c)} />
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>🎯 {c.goal.destination}</Text>
          <Text dimColor>
            진척 {height}/{c.goal.rows}
            {last?.kind === 'arrive' ? ' · 도착!' : ''}
            {c.isJudging ? ' · 판정 중…' : ''}
            {c.note ? ` · ${c.note}` : ''}
          </Text>
        </Box>
        {board}
        {c.proposal && (
          <Box flexDirection="column" borderStyle="round" borderColor="#4da3ff" paddingX={1}>
            <Text bold>목표가 바뀐 건가요?</Text>
            <Text>→ {c.proposal.destination}</Text>
            <Text dimColor>
              {c.proposal.reason} · 새 목표 {c.proposal.carry}/{c.proposal.rows}칸에서 다시 출발
            </Text>
            {proposalButtons($, Button, Box)}
          </Box>
        )}
        <Text dimColor>▲ 가까워짐 · ▶ 제자리/옆길 · ▼ 멀어짐 · ↺ 방향 전환</Text>
        <Box flexDirection="column">
          {recent.map(s => (
            <Text dimColor={s.segment !== seg}>
              <Text color={COLORS[s.kind]}>{ARROWS[s.kind]}</Text> T{s.turn} {s.reason}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>다 됐다: {c.goal.done}</Text>
          <Text dimColor>하지 말 것: {c.goal.avoid}</Text>
        </Box>
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    prompts.push(e.text)
    const c = await read($, compass)
    if (!c.goal) return next(e)

    return next({ ...e, context: [...(e.context ?? []), SESSION_NOTE] })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    const snap: TurnSnapshot = {
      turn: 0,
      prompt: prompts.join('\n---\n'),
      answer: e.answer,
      tools,
    }
    const wasSetup = isSetupTurn
    prompts = []
    tools = []
    isSetupTurn = false
    const c = await update($, compass, cur => {
      const turn = cur.turn + 1
      const isStale = cur.question !== null && turn - cur.question.turn >= EXPIRE_TURNS

      return { ...cur, turn, question: isStale ? null : cur.question }
    })
    snap.turn = c.turn

    // Judge outside this dispatch, so the turn ends without waiting on the model.
    if (c.goal && !wasSetup && e.reason === 'answer') {
      $.clock.after(1, () => {
        void judge($, snap)
      })
    }

    return result
  })

  // 입력창 위 자리는 하나다. 질문 > 목표 전환 확인 > 2턴 연속 이탈 경고 순으로 보인다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const c = await read($, compass)
    if (!c.goal) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els

    if (c.question) return questionCard($, els, c.question)

    if (c.proposal) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text color="#4da3ff">🧭 목표가 바뀐 건가요? → {clip(c.proposal.destination, 40)}</Text>
          {proposalButtons($, Button, Box)}
        </Box>
      )
    }

    const tail = c.steps.filter(s => s.segment === currentSegment(c)).slice(-2)
    const isDrifting =
      tail.length === 2 && tail.every(s => s.kind === 'flat' || s.kind === 'down')
    if (!isDrifting) return next(e)

    return (
      <Box flexDirection="row">
        <Text color="#ff4b4b">🧭 2턴 연속 목표에서 벗어나는 중: {tail[1]?.reason}</Text>
      </Box>
    )
  })
}
