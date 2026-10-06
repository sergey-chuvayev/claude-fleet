import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// findBy*/waitFor default to 1s, which a cold lazy chunk on a slow CI runner can exceed.
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
})
