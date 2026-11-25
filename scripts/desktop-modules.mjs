import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Load the Desktop's existing Cordis and PTY dependencies from its runtime.
const resources = process.resourcesPath ?? join(dirname(process.execPath), 'resources');
const runtime = join(resources, 'app.asar', 'dsh');
const desktopRequire = createRequire(join(runtime, 'package.json'));
const manifest = desktopRequire(join(runtime, 'package.json'));
if (manifest.name !== '@deepseek-ai/dsh-desktop-runtime' || manifest.version !== '0.2.2-rc.5') {
  throw new Error('WSL terminal profiles require DeepSeek Harness Desktop 0.2.2-rc.5.');
}
export const desktopModuleURL = name => pathToFileURL(desktopRequire.resolve(name)).href;
export const desktopModule = name => import(desktopModuleURL(name));
