'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(root, 'meshrelay.js')) || !fs.existsSync(path.join(root, 'agents', 'meshcore.js'))) throw new Error('Pass a MeshCentral checkout root');

const viewModeSource = path.join(__dirname, '..', 'plugin', 'mcwebcam-viewmode.js');
const viewModeTarget = path.join(root, 'public', 'scripts', 'mcwebcam-viewmode.js');
if (fs.existsSync(viewModeTarget)) {
    const installed = fs.readFileSync(viewModeTarget, 'utf8');
    if (installed !== fs.readFileSync(viewModeSource, 'utf8') && !installed.includes('root.mcwebcamViewMode = { open: open, desktopDisconnected: shutdown };')) throw new Error('MeshCentral public/scripts/mcwebcam-viewmode.js already exists with different contents');
}
fs.copyFileSync(viewModeSource, viewModeTarget);

function edit(relativePath, transform) {
    const file = path.join(root, relativePath);
    const old = fs.readFileSync(file, 'utf8');
    const next = transform(old);
    if (old !== next) fs.writeFileSync(file, next, 'utf8');
}

edit('meshrelay.js', function (source) {
    if (source.includes('protocol == 16')) return source;
    const marker15 = '    if (protocol == 15) {';
    const check = '    if (protocol == 16) {\r\n' +
        '        if ((rights != MESHRIGHT_ADMIN) && (rights == null || ((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEWONLY)) == 0) || ((rights & MESHRIGHT_NODESKTOP) != 0))) { return false; }\r\n' +
        '    }\r\n';
    if (source.includes(marker15)) {
        const at = source.indexOf(marker15);
        const closeMatch = /\r?\n    }\r?\n/.exec(source.slice(at));
        if (!closeMatch) throw new Error('MeshRelay protocol 15 rights check changed');
        const insertAt = at + closeMatch.index + closeMatch[0].length;
        const newline = closeMatch[0].startsWith('\r\n') ? '\r\n' : '\n';
        return source.slice(0, insertAt) + check.replace(/\r\n/g, newline) + source.slice(insertAt);
    }
    const functionMarker = 'function isProtocolAllowedByRights(rights, protocol) {';
    const at = source.indexOf(functionMarker);
    if (at < 0) throw new Error('MeshRelay rights check changed');
    const body = source.indexOf('\n', at) + 1;
    return source.slice(0, body) + check + source.slice(body);
});

edit(path.join('agents', 'meshcore.js'), function (source) {
    if (!source.includes('require("win-webcam").handleTunnelData(this, data)')) {
        const branch15 = source.indexOf('        } else if (this.httprequest.protocol == 15) {');
        if (branch15 >= 0) {
            const closeMatch = /\r?\n        }\r?\n/.exec(source.slice(branch15));
            if (!closeMatch) throw new Error('MeshCore audio tunnel branch boundary changed');
            const close = branch15 + closeMatch.index;
            const newline = closeMatch[0].startsWith('\r\n') ? '\r\n' : '\n';
            const webcamBranch = newline + '        } else if (this.httprequest.protocol == 16) {' + newline +
                '            // Webcam frames use the authenticated relay and existing MeshAgent WebRTC DataChannel.' + newline +
                '            var webcamRights = this.httprequest.rights;' + newline +
                '            if ((webcamRights != MESHRIGHT_ADMIN) && (((webcamRights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEW)) == 0) || ((webcamRights & MESHRIGHT_NODESKTOP) != 0))) { this.httprequest.s.end(); return; }' + newline +
                '            this.descriptorMetadata = "Remote Webcam";' + newline +
                '            try { require("win-webcam").handleTunnelData(this, data); } catch (ex) {' + newline +
                '                try { this.write(JSON.stringify({ type: "error", message: "Webcam capture is unavailable: " + String(ex).substring(0, 256) })); } catch (e) { }' + newline +
                '            }' + newline +
                '        }' + newline;
            source = source.slice(0, close) + webcamBranch + source.slice(close + closeMatch[0].length);
        } else {
            const start = source.indexOf('        } else if (this.httprequest.protocol == 7) { // Plugin data exchange');
            const comment = source.indexOf('//sendConsoleText("Got tunnel #', start);
            const close = source.lastIndexOf('        }', comment);
            if (start < 0 || comment < 0 || close <= start) throw new Error('MeshCore tunnel dispatch changed');
            const lineEnd = source.indexOf('\n', close);
            const newline = source[lineEnd - 1] === '\r' ? '\r\n' : '\n';
            const branch = '        } else if (this.httprequest.protocol == 16) {' + newline +
                '            var webcamRights = this.httprequest.rights;' + newline +
                '            if ((webcamRights != MESHRIGHT_ADMIN) && (((webcamRights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_REMOTEVIEW)) == 0) || ((webcamRights & MESHRIGHT_NODESKTOP) != 0))) { this.httprequest.s.end(); return; }' + newline +
                '            this.descriptorMetadata = "Remote Webcam";' + newline +
                '            try { require("win-webcam").handleTunnelData(this, data); } catch (ex) {' + newline +
                '                try { this.write(JSON.stringify({ type: "error", message: "Webcam capture is unavailable: " + String(ex).substring(0, 256) })); } catch (e) { }' + newline +
                '            }' + newline + '        }' + newline;
            source = source.slice(0, close) + branch + source.slice(lineEnd + 1);
        }
    }
    const cleanup = '    if (this.httprequest && this.httprequest.protocol == 16) { try { require("win-webcam").closeTunnel(this); } catch (ex) { } }';
    if (!source.includes(cleanup)) {
        const at = source.indexOf('function onTunnelClosed()');
        const brace = source.indexOf('{', at) + 1;
        if (at < 0 || brace <= 0) throw new Error('MeshCore close handler changed');
        const newline = source[brace] === '\r' ? '\r\n' : '\n';
        source = source.slice(0, brace) + newline + cleanup + source.slice(brace);
    }
    source = source.replaceAll('message: "Webcam capture is unavailable."', 'message: "Webcam capture is unavailable: " + String(ex).substring(0, 256)');
    return source;
});

edit(path.join('public', 'scripts', 'agent-redir-ws-0.1.1.js'), function (source) {
    const old = "obj.webchannel = obj.webrtc.createDataChannel('DataChannel', {}); // { ordered: false, maxRetransmits: 2 }";
    const next = "obj.webchannel = obj.webrtc.createDataChannel('DataChannel', obj.m.dataChannelOptions || {});";
    if (source.includes(next)) return source;
    if (!source.includes(old)) throw new Error('Browser DataChannel creation changed');
    return source.replace(old, next);
});

function addViewModeScript(source) {
    const marker = '<!-- MeshCentral Webcam ViewMode controller -->';
    if (source.includes(marker)) return source;
    const audioScript = '<script type="text/javascript" src="scripts/mcaudio-viewmode.js"></script>';
    const anchor = source.includes(audioScript) ? audioScript : '<script type="text/javascript" src="scripts/agent-redir-ws-0.1.1{{{min}}}.js"></script>';
    if (!source.includes(anchor)) throw new Error('MeshCentral ViewMode relay script reference changed');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return source.replace(anchor, anchor + newline + '    ' + marker + newline + '    <script type="text/javascript" src="scripts/mcwebcam-viewmode.js"></script>');
}

function addViewModeButton(source) {
    const marker = '<!-- MeshCentral Webcam ViewMode button -->';
    if (source.includes(marker)) return source;
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const button = '<!-- MeshCentral Webcam ViewMode button -->' + newline +
        '                            <input id=MCWebcamButton type=button class="btn btn-primary btn-sm mx-1" value="Webcam" title="View a remote webcam" onkeypress="return false" onkeydown="return false" onclick="if(window.mcwebcamViewMode)window.mcwebcamViewMode.open()" style="display:none" />' + newline;
    const audioLine = source.match(/^[ \t]*<input id=MCAudioMicrophoneButton[^\r\n]*$/m);
    if (audioLine) {
        const at = audioLine.index + audioLine[0].length;
        return source.slice(0, at + (source[at] === '\r' ? 2 : 1)) + button + source.slice(at + (source[at] === '\r' ? 2 : 1));
    }
    const toolsLine = source.match(/^[ \t]*<input id=DeskToolsButton[^\r\n]*$/m);
    if (toolsLine) {
        const at = toolsLine.index;
        return source.slice(0, at) + button + source.slice(at);
    }
    throw new Error('MeshCentral ViewMode toolbar anchor changed');
}

function insertAfterLine(source, anchor, text, errorMessage) {
    const at = source.indexOf(anchor);
    if (at < 0) throw new Error(errorMessage);
    const lineEnd = source.indexOf('\n', at);
    if (lineEnd < 0) throw new Error(errorMessage);
    return source.slice(0, lineEnd + 1) + text + source.slice(lineEnd + 1);
}

function addLifecycle(source) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    if (!source.includes("QV('MCWebcamButton'")) {
        const anchor = source.includes("QV('MCAudioMicrophoneButton'") ? "QV('MCAudioMicrophoneButton', mcaudioVisible);" : "QV('DeskToolsButton', (currentNode.agent) && online);";
        const visibility = '            // MeshCentral Webcam ViewMode visibility' + newline +
            '            var mcwebcamVisible = (deskState == 3) && online && (currentNode.agent != null) && isWindowsNode(currentNode) && ((rights == 0xFFFFFFFF) || (((rights & (8 | 256)) != 0) && ((rights & 65536) == 0)));' + newline +
            "            QV('MCWebcamButton', mcwebcamVisible);" + newline;
        source = insertAfterLine(source, anchor, visibility, 'MeshCentral desktop toolbar anchor changed');
    }
    const marker = 'if (window.mcwebcamViewMode) window.mcwebcamViewMode.desktopDisconnected();';
    if (!source.includes(marker)) {
        const audioMarker = 'if (window.mcaudioViewMode) window.mcaudioViewMode.desktopDisconnected();';
        if (source.includes(audioMarker)) source = source.replace(audioMarker, audioMarker + newline + '                    ' + marker);
        else {
            const functionStart = source.indexOf('function onDesktopStateChange(');
            const switchStart = source.indexOf('switch (state)', functionStart);
            const disconnectCase = source.indexOf('case 0:', switchStart);
            if (functionStart < 0 || switchStart < 0 || disconnectCase < 0) throw new Error('MeshCentral desktop disconnect lifecycle anchor changed');
            const lineEnd = source.indexOf('\n', disconnectCase);
            source = source.slice(0, lineEnd + 1) + '                    ' + marker + newline + source.slice(lineEnd + 1);
        }
    }
    return source;
}

for (const template of ['views/default3.handlebars', 'views/default.handlebars']) {
    edit(template, function (source) { return addLifecycle(addViewModeButton(addViewModeScript(source))); });
}
