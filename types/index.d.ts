export type Goal = {
  destination: string
  done: string
  avoid: string
  // How many steps (LED rows) the goal is from the start.
  rows: number
}

export type StepKind = 'start' | 'up' | 'flat' | 'down' | 'pivot' | 'arrive'

export type Step = {
  kind: StepKind
  height: number
  segment: number
  turn: number
  reason: string
}

export type Segment = { destination: string; rows: number }

export type Proposal = {
  destination: string
  done: string
  avoid: string
  rows: number
  // Steps of the new goal already covered by the work so far.
  carry: number
  reason: string
  from: 'judge' | 'model'
}

export type Compass = {
  goal: Goal | null
  steps: Step[]
  segments: Segment[]
  proposal: Proposal | null
  isJudging: boolean
  turn: number
  note: string
  // The gap question waiting above the prompt, and how many this session asked.
  question: GapQuestion | null
  asked: number
  lastAskTurn: number
}

// What the gap check found worth asking, and how it reads it.
export type GapKind = 'premise' | 'distinction' | 'principle' | 'criterion'

export type GapQuestion = {
  kind: GapKind
  question: string
  // Empty means a free-text question; the field is always offered anyway.
  options: string[]
  // The user's own words the question rests on.
  quote: string
  why: string
  turn: number
}

// Which of the two mods /hack-mode turned on, and whether its picker is up.
export type ModeName = 'off' | 'compass' | 'criteria' | 'both'

export type HackMode = { mode: ModeName; isPicking: boolean }

declare module 'claude-code' {
  interface PluginState {
    'hack-users-for-llms': { compass: Shaped<Compass>; mode: Shaped<HackMode> }
  }
}
