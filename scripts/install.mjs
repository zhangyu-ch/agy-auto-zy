import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPluginPackage } from '../lib/installer.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await installPluginPackage({ sourceRoot });

console.log(`已安装插件 ${result.pluginId} v${result.version}`);
console.log(`安装目录: ${result.destination}`);
console.log(`同步文件: ${result.fileCount} 个 (SHA-256 校验通过)`);
console.log(
  `后台服务: ${result.runtimeStarted ? '运行中' : '等待 Antigravity 自动拉起'} | 聊天底部按钮挂载: ${result.uiHealthy ? `健康 (${result.attachedWindows} 个窗口)` : '等待窗口连接'}`
);
