import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/cloud/plugin-shell.ts',
    'plugin-hub': 'src/cloud/plugin-hub.ts',
    'shell-remote': 'src/cloud/shell-remote.ts',
    hub: 'src/cloud/hub.ts',
    daemon: 'src/daemon/daemon.ts',
    protocol: 'src/shared/protocol.ts',
  },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  // DSH 的 seam 包由宿主提供，不能打进产物，否则会出现两份 Service 定义。
  deps: { neverBundle: [/^@deepseek-ai\//, 'ws'] },
})