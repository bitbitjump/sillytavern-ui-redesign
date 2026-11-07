import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateConnectorConfig } from './connector.mjs';

const label = 'local.tavern.model-connector';
const xml = text => text.replace(/[<>&"']/g, character =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);

try {
    if (process.platform !== 'darwin' || !process.argv[2]) {
        throw new Error('請在 Mac 以 node install-macos.mjs <本機設定檔> 執行。');
    }
    const configPath = resolve(process.argv[2]);
    validateConnectorConfig(JSON.parse(await readFile(configPath, 'utf8')));
    await chmod(configPath, 0o600);
    const directory = join(homedir(), 'Library', 'LaunchAgents');
    await mkdir(directory, { recursive: true });
    const plist = join(directory, `${label}.plist`);
    const args = [process.execPath, fileURLToPath(new URL('./connector.mjs', import.meta.url)), configPath];
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
</dict></plist>\n`;
    try {
        await writeFile(plist, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error.code !== 'EEXIST' || (await readFile(plist, 'utf8')) !== content) {
            throw new Error('已存在不同的啟動設定。請先檢查原本的 LaunchAgent。');
        }
    }
    execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'ignore' });
    const domain = `gui/${userInfo().uid}`;
    try {
        execFileSync('/bin/launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
    } catch {
        execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
    }
    console.log(`酒館連接器已註冊。日後登入 Mac 時會自動執行。要停止請用 launchctl bootout ${domain}/${label}`);
} catch (error) {
    console.error(error instanceof SyntaxError ? '連接器設定檔格式錯誤。' : error.message);
    process.exitCode = 1;
}
