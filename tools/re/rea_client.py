"""Cliente MCP mínimo para REA (https://github.com/morluto/rea): mantiene abierta una
sesión de Ghidra y lanza lotes de consultas sobre DC.EXE.

Uso (desde la raíz del proyecto, tras `tools/re/setup-rea.sh`):
    python tools/re/rea_client.py x:0x46e964 d:0x41a61c c:0x432d50 r:0x432dec
      x:ADDR  decompila las funciones que referencian una dirección (cadena/dato)
      d:ADDR  decompila una función
      c:ADDR  decompila las funciones llamadas por ADDR
      r:ADDR  decompila las funciones que llaman a ADDR
Salida: .re/out/decomp/<dirección>.c

Variables de entorno: DC_EXE (por defecto C:/code/DCOLONY/DC.EXE) y RE_HOME (por defecto .re).
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading

RE_HOME = os.path.abspath(os.environ.get('RE_HOME', '.re'))
DC_EXE = os.environ.get('DC_EXE', r'C:\code\DCOLONY\DC.EXE')


def _find(pattern_dir, prefix):
    d = os.path.join(RE_HOME, pattern_dir)
    for n in sorted(os.listdir(d)):
        if n.startswith(prefix):
            return os.path.join(d, n)
    raise FileNotFoundError(f'{prefix}* en {d}')


class Rea:
    def __init__(self):
        node_dir = _find('node22', 'node-v22')
        node = os.path.join(node_dir, 'node.exe' if os.name == 'nt' else 'bin/node')
        entry = os.path.join(RE_HOME, 'rea', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs')
        env = dict(os.environ)
        env.update({
            'JAVA_HOME': _find('jdk21', 'jdk-21'),
            'GHIDRA_INSTALL_DIR': _find('ghidra', 'ghidra_'),
            'REA_ANALYSIS_PROVIDER': 'ghidra',
            'REA_GHIDRA_STARTUP_TIMEOUT_MS': '900000',
            'REA_MCP_MAX_RESPONSE_BYTES': str(64 * 1024 * 1024),
        })
        os.makedirs(os.path.join(RE_HOME, 'out'), exist_ok=True)
        self.p = subprocess.Popen([node, entry, 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=open(os.path.join(RE_HOME, 'out', 'mcp.err'), 'ab'), env=env)
        self.id = 0
        self.q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self.call('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                                 'clientInfo': {'name': 'open-dark-colony', 'version': '1'}})
        self._send({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}})

    def _reader(self):
        for line in self.p.stdout:
            try:
                self.q.put(json.loads(line))
            except Exception:
                pass

    def _send(self, msg):
        self.p.stdin.write((json.dumps(msg) + '\n').encode())
        self.p.stdin.flush()

    def call(self, method, params, timeout=1800):
        self.id += 1
        i = self.id
        self._send({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params})
        while True:
            msg = self.q.get(timeout=timeout)
            if msg.get('id') == i:
                return msg

    def tool(self, name, args):
        r = self.call('tools/call', {'name': name, 'arguments': args})
        if 'error' in r:
            return {'error': r['error']}
        res = r['result']
        if res.get('structuredContent') is not None:
            return res['structuredContent']
        txt = '\n'.join(c.get('text', '') for c in res.get('content', []))
        try:
            return json.loads(txt)
        except Exception:
            return {'text': txt}


def _addresses(x):
    nr = x.get('normalized_result', x)
    if isinstance(nr, list):
        return [v for v in nr if isinstance(v, str)]
    return sorted(set(re.findall(r'"(?:address|entry)": "(0x[0-9a-f]+)"', json.dumps(nr))))


def main(argv):
    out = os.path.join(RE_HOME, 'out', 'decomp')
    os.makedirs(out, exist_ok=True)
    r = Rea()
    print(r.tool('open_binary', {'path': DC_EXE, 'provider_id': 'ghidra'}), flush=True)
    todo = []
    force = '-f' in argv
    for arg in argv:
        if arg == '-f':
            continue
        k, a = arg.split(':')
        if k == 'd':
            todo.append(a)
        elif k == 'c':
            todo += _addresses(r.tool('procedure_callees', {'procedure': a}))
        elif k == 'r':
            todo += _addresses(r.tool('procedure_callers', {'procedure': a}))
        elif k == 'x':
            for ref in _addresses(r.tool('xrefs', {'address': a})):
                c = r.tool('resolve_containing_procedure', {'address': ref})
                cn = c.get('normalized_result', c)
                p = cn.get('procedure')
                pa = p.get('address') if isinstance(p, dict) else cn.get('procedure_address') or cn.get('address')
                print('xref', a, ref, '->', pa, flush=True)
                if pa:
                    todo.append(pa)
    for pa in dict.fromkeys(todo):
        fn = os.path.join(out, pa + '.c')
        if os.path.exists(fn) and not force:
            print('ya existe', pa)
            continue
        d = r.tool('procedure_pseudo_code', {'procedure': pa})
        nr = d.get('normalized_result', d)
        code = (nr.get('pseudo_code') or nr.get('code') or nr.get('text')) if isinstance(nr, dict) else nr
        if not isinstance(code, str):
            code = json.dumps(d, indent=1)
        with open(fn, 'w', encoding='utf-8') as f:
            f.write(code)
        print('escrito', fn, len(code), flush=True)


if __name__ == '__main__':
    main(sys.argv[1:])
