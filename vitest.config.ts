import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // 集成测试会真实起 daemon 并占端口，串行执行避免端口冲突。
    fileParallelism: false,
    testTimeout: 30_000,
  },
})