import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { BandEvent, TurnEnd } from './shared.ts'

import type { Gap, GapKind, GapQuestion } from '../types'

// 기준 공백 점검 mod. criteria-init이 켠 곳(.criteria/config.json의 hook.enabled)에서만 돈다.
// 턴이 끝나면 그 턴을 판정 모델에 보여 주고, 사용자 생각에 빈 곳이 보이면 입력창 위에 질문 하나를 띄운다.
// 꺼져 있거나 오류가 나면 아무것도 그리지 않는다. 사용자 입력은 막지 않는다.

const PLUGIN = 'hack-users-for-llms'
const JUDGE_MODEL = 'sonnet'
// 답하지 않은 질문은 이만큼 턴이 지나면 내린다.
const EXPIRE_TURNS = 3
const ANSWER_TAG = '[criteria-gap 점검 답변]'

type Config = {
  enabled: boolean
  intensity: 'light' | 'active'
  max_per_session: number
  cooldown_turns: number
}

const DEFAULTS: Config = { enabled: false, intensity: 'light', max_per_session: 3, cooldown_turns: 3 }

const EMPTY: Gap = { pending: null, asked: 0, lastAskTurn: -999, turn: 0 }

const gap = atom({ plugin: 'hack-users-for-llms', key: 'gap' } as const, EMPTY, { shape: 'gap-1' })

const KINDS: GapKind[] = ['premise', 'distinction', 'principle', 'criterion']

const KIND_LABEL: Record<GapKind, string> = {
  premise: '생략된 전제',
  distinction: '구분',
  principle: '원리 이해',
  criterion: '판단 기준',
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

// ---------- 설정과 기록소 (hooks/criteria_hook.py와 같은 규칙) ----------

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

// 프로젝트 설정이 있으면 그것, 없으면 전역. 깨진 설정은 꺼진 것으로 본다.
async function loadConfig($: EngineInterface, dirs: Dirs): Promise<Config> {
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir || !(await $.fs.exists(`${dir}/config.json`))) continue
    try {
      const raw = JSON.parse(await $.fs.read(`${dir}/config.json`))?.hook ?? {}

      return {
        enabled: raw.enabled === true,
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

// ---------- 판정 ----------

const RULE: Record<Config['intensity'], string> = {
  light: '- 답이 없으면 다음 작업이 틀어지거나 사용자가 잘못 결정할 것이 분명할 때만 묻는다. 애매하면 묻지 않는다.',
  active: '- 위 네 가지 중 하나가 분명히 보이고 답에 따라 결과가 달라지면 묻는다.',
}

const judgeSystem = (intensity: Config['intensity']) => `당신은 사람과 AI의 대화에서 사용자의 생각에 빈 곳이 있는지 점검합니다. 방금 끝난 한 턴(사용자 메시지와 AI 답변)을 보고, 지금 사용자에게 물을 질문이 하나 있는지 판정합니다. AI가 아니라 사용자의 생각을 점검합니다.

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

JSON 한 개만 출력합니다. 다른 말은 쓰지 않습니다.
{"ask":false,"kind":"premise|distinction|principle|criterion","question":"","options":[],"quote":"근거가 된 사용자 발화, 60자 이내","why":"지금 묻는 이유, 40자 이내"}`

const judgePrompt = (known: string[], prompt: string, answer: string) =>
  [
    '확정 기준:',
    known.length ? known.join('\n') : '(없음)',
    '',
    `이번 턴 사용자 메시지:\n${clip(prompt, 2500)}`,
    '',
    `이번 턴 AI 답변:\n${clip(answer || '(없음)', 3500)}`,
  ].join('\n')

export const parseQuestion = (text: string, turn: number): GapQuestion | null => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>
    const kind = KINDS.find(k => k === raw.kind)
    const question = str(raw.question)
    const quote = str(raw.quote)
    if (raw.ask !== true || !kind || !question || !quote) return null
    const options = Array.isArray(raw.options)
      ? [...new Set(raw.options.map(str).filter(Boolean))].slice(0, 4).map(o => clip(o, 40))
      : []

    return {
      kind,
      question: clip(question, 160),
      options,
      quote: clip(quote, 80),
      why: clip(str(raw.why), 60),
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
    '이 답은 criteria-gap 점검 mod에서 왔다. 다루는 법은 criteria-gap 스킬의 "점검 mod 답변" 절에 있다.',
  ]
    .filter(Boolean)
    .join('\n')

// ---------- module ----------

// 턴 안에서만 쓰는 값. 다시 읽히면 진행 중인 턴 하나만 잃는다.
let prompts: string[] = []
let isJudging = false

async function check($: EngineInterface, turn: number, prompt: string, answer: string) {
  if (isJudging) return
  isJudging = true
  try {
    const dirs = await criteriaDirs($)
    const cfg = await loadConfig($, dirs)
    if (!cfg.enabled) return
    const g = await read($, gap)
    const isCooling = turn - g.lastAskTurn <= cfg.cooldown_turns
    if (g.pending || g.asked >= cfg.max_per_session || isCooling) return

    const res = await $.model.complete({
      model: JUDGE_MODEL,
      system: judgeSystem(cfg.intensity),
      prompt: judgePrompt(await confirmedIndex($, dirs), prompt, answer),
      maxTokens: 500,
      effort: 'low',
    })
    const q = res.isAnswered ? parseQuestion(res.text, turn) : null
    if (!q) return
    await update($, gap, cur =>
      cur.pending ? cur : { ...cur, pending: q, asked: cur.asked + 1, lastAskTurn: turn },
    )
  } catch {
    // 점검이 실패해도 대화는 그대로 간다.
  } finally {
    isJudging = false
  }
}

async function reply($: EngineInterface, answer: string) {
  const q = (await read($, gap)).pending
  if (!q || !answer.trim()) return
  await update($, gap, cur => ({ ...cur, pending: null }))
  await $.prompt.submit({ text: answerPrompt(q, answer.trim()) })
}

export async function gapTurn($: EngineInterface, e: TurnEnd) {
  const prompt = prompts.join('\n---\n').trim()
  prompts = []
  const g = await update($, gap, cur => {
    const turn = cur.turn + 1
    const isStale = cur.pending !== null && turn - cur.pending.turn >= EXPIRE_TURNS

    return { ...cur, turn, pending: isStale ? null : cur.pending }
  })

  // 판정은 이 턴 밖에서 돈다. 턴이 모델 호출을 기다리지 않게.
  if (prompt && e.reason === 'answer' && !g.pending) {
    $.clock.after(1, () => {
      void check($, g.turn, prompt, e.answer)
    })
  }
}

export async function gapBand($: EngineInterface, e: BandEvent) {
  const q = (await read($, gap)).pending
  if (!q) return null
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  // 모바일에는 입력칸이 없다. 그때는 보기와 "모름"만 보인다.
  const Input = 'Input' in els ? els.Input : undefined

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#c792ea" paddingX={1}>
      <Text bold color="#c792ea">
        🔍 {KIND_LABEL[q.kind]} 점검
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
          onSubmit={v => reply($, v)}
        />
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="gap-unknown" label="모름" onPress={() => reply($, '모름')} />
        <Button
          key="gap-skip"
          label="건너뛰기"
          onPress={() => update($, gap, cur => ({ ...cur, pending: null }))}
        />
      </Box>
    </Box>
  )
}


export const gapPrompt = (e: { text: string; command?: unknown }) => {
  if (!e.command && !e.text.startsWith(ANSWER_TAG)) prompts.push(e.text)
}
