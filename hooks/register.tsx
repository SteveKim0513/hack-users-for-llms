import type { Register } from 'claude-code'

import { compassBand, compassPrompt, compassTurn, registerCompass } from './compass.tsx'
import { gapBand, gapPrompt, gapTurn } from './gap.tsx'

// 이 플러그인의 mod: 기준 공백 점검(gap)과 /compass.
// 같은 이벤트에 훅을 두 번 걸 수 없어서 공통 이벤트는 여기서 한 번 받아 나눠 준다.
export const register: Register = on => {
  registerCompass(on)

  on('prompt.submit', ($, e, next) => {
    gapPrompt(e)
    compassPrompt(e)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    await gapTurn($, e)
    await compassTurn($, e)

    return result
  })

  // 입력창 위 자리는 하나다. 점검 질문이 떠 있으면 그것을 먼저 보인다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    return (await gapBand($, e)) ?? (await compassBand($, e)) ?? next(e)
  })
}
