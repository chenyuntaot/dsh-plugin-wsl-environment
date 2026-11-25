#!/usr/bin/env python3
"""Build an rc.5 Desktop bundle with the native terminal profile patch."""
import argparse
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.2.2-rc.5'
OWNER = 'dsh-wsl-env'
API_NAME = '@deepseek-ai/dsh-api-terminal-controller'
UI_NAME = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
CLIENT_EXTERNAL = (
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-gateway/client',
    '@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime',
)


def change(path, old, new):
    text = path.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise ValueError(f'{path}: expected a single match for {old!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


def file_for(path, relative):
    candidate = path / 'package' / relative
    if not candidate.is_file():
        raise FileNotFoundError(candidate)
    return candidate.resolve()


def adapt_source(api, ui):
    source = api / 'src'
    shutil.copyfile(ROOT / 'scripts/terminal-wire.mjs', source / 'terminal-wire.mjs')
    change(source / 'index.ts', 'export type * from',
           "import { decodeSelection, encodeMenuShell } from './terminal-wire.mjs'\n\nexport type * from")
    change(source / 'index.ts', '...contributed.filter(shell => !shell.sessionDefault)]',
           '...contributed.filter(shell => !shell.sessionDefault)].map(encodeMenuShell)')
    change(source / 'index.ts', 'const choice = userTerminalChoice(request)', 'const choice = userTerminalChoice(decodeSelection(request))')
    change(source / 'client/index.ts', 'export type { TerminalView,',
           "import { decodeMenuShell } from '../terminal-wire.mjs'\n\nexport type { TerminalView,")
    change(source / 'client/index.ts', 'launchShellChoices(result.value, preferredShell())',
           'launchShellChoices(result.value.map(decodeMenuShell), preferredShell())')
    change(source / 'client/model.ts', 'import { preferredShell, rememberShell }',
           "import { decodeMenuShell, encodeSelection } from '../terminal-wire.mjs'\nimport { preferredShell, rememberShell }")
    change(source / 'client/model.ts', 'id: this.id, ...selection,', 'id: this.id, ...encodeSelection(selection),')
    change(source / 'client/model.ts', '        const path = this.closing === undefined ? rememberableNativeShellPath(info, selection) : undefined\n        if (path !== undefined) rememberShell(path)', '''        if (this.closing === undefined && selection.shellPath === info.shell.path) {
          // The rc.5 reply omits preference metadata. A failed check leaves the saved preference alone.
          void this.remote.shells(this.sessionId, this.lifetime.signal).then(result => {
            if (result.ok && !this.stopped() && !result.value.some(shell => decodeMenuShell(shell).sessionDefault)) {
              rememberShell(info.shell.path)
            }
          }).catch(() => {})
        }''')
    change(source / 'client/model.ts', 'rememberableNativeShellPath, ', '')
    guide = ui / 'src/client/TerminalGuide.tsx'
    change(guide, '  useEffect(() => {\n    if (!open) return', '''  const menuOpen = tab.visible && open
  useEffect(() => { if (!tab.visible) setOpen(false) }, [tab.visible])
  useEffect(() => {
    if (!menuOpen) return''')
    change(guide, '}, [open, attempt, loadShells])', '}, [menuOpen, attempt, loadShells])')
    change(guide, 'open={open} portal', 'open={menuOpen} portal')
    change(guide, 'aria-expanded={open}', 'aria-expanded={menuOpen}')
    change(guide, "from '@deepseek-ai/dsh-api-terminal-controller/client'",
           "from '../../../../api/terminal-controller/src/client/launch-shells.ts'")


def bundle_host(src, out, esbuild):
    target = out / 'native-terminal.mjs'
    subprocess.run([esbuild, src, '--bundle', '--platform=node', '--format=esm', '--target=node22',
                    '--packages=external', f'--outfile={target}'], check=True)
    code = target.read_text(encoding='utf-8')
    substitutions = []
    def rewrite(match):
        binding, name = match.groups()
        identifier = f'installedModule{len(substitutions)}'
        if binding.startswith('{'):
            destructure = re.sub(r'\s+as\s+', ': ', binding)
            declaration = f'const {destructure} = {identifier};'
        else:
            if not re.fullmatch(r'[\w$]+', binding):
                raise ValueError(f'Unsupported host import: {binding}')
            declaration = f'const {binding} = {identifier}.default;'
        substitutions.append(f'const {identifier} = await desktopModule({json.dumps(name)});\n{declaration}')
        return ''
    code = re.sub(r'^import ([^;]+) from "(@deepseek-ai/[^\"]+)";$', rewrite, code, flags=re.M)
    if not substitutions:
        raise ValueError('No stock Host imports resolved')
    code, replacements = re.subn(r'(createLazyRequire\("@xterm/[^"\n]+", )import\.meta\.url',
                                 rf'\g<1>desktopModuleURL("{API_NAME}")', code)
    if replacements != 2:
        raise ValueError('Unexpected native terminal lazy module layout')
    target.write_text("import { desktopModule, desktopModuleURL } from './desktop-modules.mjs';\n" + '\n'.join(substitutions) + '\n' + code, encoding='utf-8')
    (out / 'native-terminal.typert.mjs').write_text(f'''import {{ desktopModule }} from './desktop-modules.mjs';
const {{ TYPERT: stock }} = await desktopModule('{API_NAME}/typert');
export const TYPERT = {{ ...stock, package: '{OWNER}' }};
''', encoding='utf-8')


def bundle_client(api, ui, work, out, esbuild, deps):
    entry = work / 'entry.ts'
    entry.write_text(f'''import * as TerminalModels from {json.dumps(str(api / 'src/client/index.ts'))};
import * as TerminalSidebar from {json.dumps(str(ui / 'src/client/index.ts'))};
export {{ TerminalModels, TerminalSidebar }};
''', encoding='utf-8')
    aliases = {
        '@deepseek-ai/dsh-deque': file_for(deps / '@deepseek-ai/dsh-deque', 'lib/index.js'),
        '@deepseek-ai/dsh-util-crypto': file_for(deps / '@deepseek-ai/dsh-util-crypto', 'lib/index.js'),
        '@deepseek-ai/dsh-typert-protocol': file_for(deps / '@deepseek-ai/dsh-typert-protocol', 'src/remote-error.ts'),
        '@xterm/xterm': file_for(deps / '@xterm/xterm', 'lib/xterm.js'),
        '@xterm/xterm/css/xterm.css': file_for(deps / '@xterm/xterm', 'css/xterm.css'),
        '@xterm/addon-fit': file_for(deps / '@xterm/addon-fit', 'lib/addon-fit.js'),
    }
    target = work / 'terminal-client.cjs'
    subprocess.run([esbuild, entry, '--bundle', '--platform=browser', '--format=cjs', '--target=es2022',
                    '--jsx=automatic', '--loader:.module.css=local-css', f'--outfile={target}',
                    *[f'--external:{name}' for name in CLIENT_EXTERNAL],
                    *[f'--alias:{name}={path}' for name, path in aliases.items()]], check=True)
    style = target.with_suffix('.css').read_text(encoding='utf-8')
    compiled = target.read_text(encoding='utf-8')
    output = out / 'client.js'
    change(output, '    const { createElement:', '''    const nativeTerminal = (() => {
      const module = { exports: {} };
''' + compiled + '''      return module.exports;
    })();
    const { createElement:''')
    change(output, '      apply(ctx) {\n        ctx.effect(() => ctx.locale', '''      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = ''' + json.dumps(style) + ''';
          document.head.append(style);
          return () => style.remove();
        });
        ctx.plugin(nativeTerminal.TerminalModels);
        ctx.plugin(nativeTerminal.TerminalSidebar);
        ctx.effect(() => ctx.locale''')


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('published', type=Path, help='Exact rc.5 packages with the native source patch applied')
    cli.add_argument('deps', type=Path, help='Verified packages extracted below name/package')
    cli.add_argument('esbuild', type=Path)
    cli.add_argument('output', type=Path, help='New release staging path')
    args = cli.parse_args()
    api = args.published.resolve() / 'packages/api/terminal-controller'
    ui = args.published.resolve() / 'packages/client/ui-sidebar-terminal'
    for source, name in ((api, API_NAME), (ui, UI_NAME)):
        manifest = json.loads((source / 'package.json').read_text(encoding='utf-8'))
        if (manifest['name'], manifest['version']) != (name, VERSION):
            raise ValueError(f'Unexpected upstream package at {source}')
    out = args.output.resolve()
    out.mkdir()
    for name in ('package.json', 'client.js', 'index.js', 'README.md', 'icon.svg'):
        shutil.copyfile(ROOT / name, out / name)
    for name in ('lib', 'locale', 'docs'):
        shutil.copytree(ROOT / name, out / name)
    for name in ('desktop-modules.mjs', 'terminal-definitions.mjs'):
        shutil.copyfile(ROOT / 'scripts' / name, out / name)
    change(out / 'index.js', "import { z } from 'zod';",
           "import { z } from 'zod';\nimport { TerminalController } from './native-terminal.mjs';\n"
           "import { TYPERT } from './native-terminal.typert.mjs';\n"
           "import { registerTerminalDefinitions } from './terminal-definitions.mjs';\nexport { TerminalController };")
    change(out / 'index.js', "  if (process.platform !== 'win32') return;",
           "  if (process.platform !== 'win32') return;\n  registerTerminalDefinitions(ctx.typert, TYPERT);\n  ctx.plugin(TerminalController, {});")
    change(out / 'index.js', "  'workingDirectory',", "  'workingDirectory', 'typert',")
    (out / 'cordis.patch.yml').write_text('''- id: ui-sidebar-terminal
  disabled: true
- id: terminal-controller
  disabled: true
- insert:
    - id: dsh-wsl-env
      name: dsh-wsl-env
''', encoding='utf-8')
    manifest = json.loads((out / 'package.json').read_text(encoding='utf-8'))
    manifest['version'] = '0.1.0-dev.10'
    manifest['files'].extend(['native-terminal.mjs', 'native-terminal.typert.mjs',
                              'desktop-modules.mjs', 'terminal-definitions.mjs'])
    manifest['dsh']['client']['inject'].extend([
        '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-sidebar-right',
        '@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-shortcuts',
    ])
    manifest['dsh']['client']['external'] = list(CLIENT_EXTERNAL)
    (out / 'package.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    with tempfile.TemporaryDirectory(prefix='wsl-native-build-', dir=out.parent) as scratch:
        work = Path(scratch)
        api_copy = work / 'packages/api/terminal-controller'
        ui_copy = work / 'packages/client/ui-sidebar-terminal'
        shutil.copytree(api, api_copy, ignore=shutil.ignore_patterns('lib', 'node_modules'))
        shutil.copytree(ui, ui_copy, ignore=shutil.ignore_patterns('lib', 'node_modules'))
        adapt_source(api_copy, ui_copy)
        bundle_host(api_copy / 'src/index.ts', out, str(args.esbuild.resolve()))
        bundle_client(api_copy, ui_copy, work, out, str(args.esbuild.resolve()), args.deps.resolve())


if __name__ == '__main__':
    main()
