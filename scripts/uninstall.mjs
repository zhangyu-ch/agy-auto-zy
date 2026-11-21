import { uninstallPluginPackage } from '../lib/installer.mjs';

const keepSettings = process.argv.includes('--keep-settings');
const result = await uninstallPluginPackage({ keepSettings });
console.log(`已卸载插件目录: ${result.destination} (保留用户配置: ${result.keepSettings})`);
