import type { RenderInput, TurnCompleteInput } from 'claude-code'

// 두 기능이 함께 받는 이벤트. 같은 이벤트에 훅을 두 번 걸 수 없어 register.tsx가 한 번 받아 나눠 준다.
export type BandEvent = RenderInput<'AbovePrompt'>
export type TurnEnd = TurnCompleteInput
