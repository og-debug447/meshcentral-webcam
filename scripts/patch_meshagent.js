'use strict';
const fs = require('fs');
const path = require('path');
const sourceRoot = path.resolve(__dirname, '..');
const agentFiles = [
    ['agent/ILibDuktape_Webcam.c', 'microscript/ILibDuktape_Webcam.c'],
    ['agent/ILibDuktape_Webcam.h', 'microscript/ILibDuktape_Webcam.h']
];
const root = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(root, 'MeshAgent.sln')) || !fs.existsSync(path.join(root, 'microscript', 'ILibDuktape_ScriptContainer.c'))) throw new Error('Pass a MeshAgent checkout root');
for (const [from, to] of agentFiles) fs.copyFileSync(path.join(sourceRoot, from), path.join(root, to));

function edit(relativePath, transform) {
    const file = path.join(root, relativePath);
    const old = fs.readFileSync(file, 'utf8');
    const next = transform(old);
    if (old !== next) fs.writeFileSync(file, next, 'utf8');
}

edit(path.join('microscript', 'ILibDuktape_ScriptContainer.c'), function (source) {
    if (!source.includes('#include "ILibDuktape_Webcam.h"')) {
        source = source.replace('#include "ILibDuktape_WebRTC.h"', '#include "ILibDuktape_WebRTC.h"\r\n#ifdef WIN32\r\n#include "ILibDuktape_Webcam.h"\r\n#endif');
    }
    if (!source.includes('ILibDuktape_Webcam_Init(ctx);')) {
        const webRtc = source.indexOf('ILibDuktape_WebRTC_Init(ctx);');
        const guard = source.lastIndexOf('#ifndef NO_WEBRTC', webRtc);
        if (webRtc < 0 || guard < 0) throw new Error('ScriptContainer module-init point changed');
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const init = '#ifdef WIN32' + newline + '\t\tILibDuktape_Webcam_Init(ctx);' + newline + '#endif' + newline;
        source = source.slice(0, guard) + init + source.slice(guard);
    }
    return source;
});

for (const dir of ['meshconsole', 'meshservice']) {
    for (const file of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.vcxproj'))) {
        edit(path.join(dir, file), function (source) {
            if (!source.includes('..\\microscript\\ILibDuktape_Webcam.c')) {
                const marker = '<ClCompile Include="..\\microscript\\ILibDuktape_WebRTC.c" />';
                if (!source.includes(marker)) throw new Error(file + ' compile item changed');
                source = source.replace(marker, marker + '\r\n    <ClCompile Include="..\\microscript\\ILibDuktape_Webcam.c" />');
            }
            if (!source.includes('..\\microscript\\ILibDuktape_Webcam.h')) {
                const marker = '<ClInclude Include="..\\microscript\\ILibDuktape_WebRTC.h" />';
                if (!source.includes(marker)) throw new Error(file + ' include item changed');
                source = source.replace(marker, marker + '\r\n    <ClInclude Include="..\\microscript\\ILibDuktape_Webcam.h" />');
            }
            if (!source.includes('Mf.lib;Mfplat.lib;mfreadwrite.lib;mfuuid.lib;windowscodecs.lib;')) {
                const dependencyMarker = '%(AdditionalDependencies)';
                if (!source.includes(dependencyMarker)) throw new Error(file + ' linker dependency list changed');
                source = source.replaceAll(dependencyMarker, 'Mf.lib;Mfplat.lib;mfreadwrite.lib;mfuuid.lib;windowscodecs.lib;' + dependencyMarker);
            }
            return source;
        });
    }
}

edit('makefile', function (source) {
    if (source.includes('microscript/ILibDuktape_Webcam.c')) return source;
    const marker = 'SOURCES += microscript/ILibDuktape_ScriptContainer.c';
    const at = source.indexOf(marker);
    if (at < 0) throw new Error('MeshAgent makefile source list changed');
    const end = source.indexOf('\n', at);
    return source.slice(0, end) + ' microscript/ILibDuktape_Webcam.c' + source.slice(end);
});
