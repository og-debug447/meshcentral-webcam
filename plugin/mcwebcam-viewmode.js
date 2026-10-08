(function (root) {
    'use strict';
    if (root.mcwebcamViewMode) return;

    var source = {
        nodeId: null, session: null, devices: [], selectedDeviceId: null,
        width: 640, height: 480, fps: 10, wantVideo: false, starting: false,
        retryTimer: null, retryCount: 0, closing: false, imageUrl: null,
        pending: new Uint8Array(0), lastSequence: null, frameCount: 0,
        frameBytes: 0, lastFrameTime: 0, lateFrames: 0, maxGapMs: 0,
        captureStats: null, status: 'Not connected'
    };

    function element(id) { return root.document.getElementById(id); }
    function connected() { return !!(source.session && source.session.redirect && source.session.redirect.State >= 3); }
    function setStatus(message) {
        source.status = message;
        var status = element('mcwebcamStatus');
        if (status) status.textContent = message;
    }
    function send(message) {
        if (!connected()) return false;
        try { source.session.redirect.sendText(message); return true; } catch (e) { return false; }
    }
    function updateDiagnostics() {
        var diagnostics = element('mcwebcamDiagnostics');
        if (!diagnostics) return;
        var parts = [];
        if (source.captureStats) {
            var seconds = Math.max(0.001, source.captureStats.elapsedMs / 1000);
            parts.push('Agent: ' + (source.captureStats.frames / seconds).toFixed(1) + ' frames/s, ' + Math.round(source.captureStats.bytes / seconds / 1024) + ' KiB/s, ' + source.captureStats.emptyReads + ' empty reads, ' + source.captureStats.blockedPolls + ' backpressured checks.');
        } else parts.push('Agent timing: collecting…');
        parts.push('Browser: ' + source.frameCount + ' frames, ' + Math.round(source.frameBytes / 1024) + ' KiB received, ' + source.lateFrames + ' arrival gaps over 150 ms, longest gap ' + source.maxGapMs + ' ms.');
        diagnostics.textContent = parts.join(' ');
    }
    function renderDevices() {
        var select = element('mcwebcamDevices');
        if (!select) return;
        while (select.options.length) select.remove(0);
        source.devices.forEach(function (device) {
            if (!device || typeof device.id !== 'string' || typeof device.name !== 'string') return;
            var option = root.document.createElement('option');
            option.value = device.id;
            option.textContent = device.name;
            select.appendChild(option);
        });
        if (source.selectedDeviceId) select.value = source.selectedDeviceId;
        if (!select.value && select.options.length) { select.selectedIndex = 0; source.selectedDeviceId = select.value; }
        select.disabled = !connected() || select.options.length === 0 || source.wantVideo || source.starting;
        var start = element('mcwebcamStart');
        var stop = element('mcwebcamStop');
        if (start) start.disabled = !select.value || !connected() || source.wantVideo || source.starting;
        if (stop) stop.disabled = !source.wantVideo && !source.starting;
        updateDiagnostics();
    }
    function stopVideo(message) {
        source.wantVideo = false;
        source.starting = false;
        source.pending = new Uint8Array(0);
        source.lastSequence = null;
        send({ cmd: 'stop' });
        if (message) setStatus(message);
        renderDevices();
    }
    function showFrame(payload, sequence) {
        if (source.lastSequence !== null && ((sequence - source.lastSequence) >>> 0) === 0) return;
        source.lastSequence = sequence;
        var image = element('mcwebcamImage');
        if (!image || !root.URL || !root.Blob) return;
        var now = Date.now();
        if (source.lastFrameTime !== 0) {
            var gap = now - source.lastFrameTime;
            if (gap > 150) source.lateFrames++;
            if (gap > source.maxGapMs) source.maxGapMs = gap;
        }
        source.lastFrameTime = now;
        source.frameCount++;
        source.frameBytes += payload.byteLength;
        var url = root.URL.createObjectURL(new root.Blob([payload], { type: 'image/jpeg' }));
        var oldUrl = source.imageUrl;
        source.imageUrl = url;
        image.onload = function () { if (oldUrl) root.URL.revokeObjectURL(oldUrl); };
        image.onerror = function () { if (source.imageUrl === url) { root.URL.revokeObjectURL(url); source.imageUrl = null; } };
        image.src = url;
        updateDiagnostics();
    }
    function appendBinary(bytes) {
        var incoming = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var combined = new Uint8Array(source.pending.length + incoming.length);
        combined.set(source.pending, 0); combined.set(incoming, source.pending.length); source.pending = combined;
        while (source.pending.length >= 16) {
            if (source.pending[0] !== 0x4D || source.pending[1] !== 0x43 || source.pending[2] !== 0x57 || source.pending[3] !== 0x43 || source.pending[4] !== 1 || source.pending[5] !== 0 || new DataView(source.pending.buffer, source.pending.byteOffset, source.pending.byteLength).getUint16(6, true) !== 16) {
                source.pending = source.pending.slice(1);
                continue;
            }
            var view = new DataView(source.pending.buffer, source.pending.byteOffset, source.pending.byteLength);
            var length = view.getUint32(12, true);
            if (length < 4 || length > 1024 * 1024) { source.pending = source.pending.slice(4); continue; }
            if (source.pending.length < 16 + length) return;
            var sequence = view.getUint32(8, true);
            showFrame(source.pending.slice(16, 16 + length), sequence);
            source.pending = source.pending.slice(16 + length);
        }
    }
    function onMessage(activeSession, data) {
        if (!source.session || source.session !== activeSession || activeSession.closing) return;
        var message;
        try { message = JSON.parse(data); } catch (e) { return; }
        if (message.type === 'devices') {
            source.devices = Array.isArray(message.devices) ? message.devices : [];
            renderDevices();
            setStatus(source.devices.length ? 'Choose a webcam, then start viewing.' : 'No active webcams found.');
        } else if (message.type === 'captureStats') {
            source.captureStats = message;
            updateDiagnostics();
        } else if (message.type === 'state') {
            if (message.state === 'running' || message.state === 'reconnected') setStatus('Webcam is streaming.');
            else if (message.state === 'device-lost') setStatus('The webcam disconnected; waiting for it to return.');
            else if (message.state === 'stopped') setStatus('Webcam stopped.');
        } else if (message.type === 'error') {
            source.wantVideo = false; source.starting = false;
            setStatus('Webcam error: ' + (message.message || 'Unknown error'));
            renderDevices();
        }
    }
    function connect(nodeId, reconnecting) {
        if (typeof root.CreateAgentRedirect !== 'function' || !root.meshserver) { setStatus('MeshCentral agent relay support is unavailable.'); return; }
        var activeSession = { nodeId: nodeId, redirect: null, closing: false };
        var module = {
            protocol: 16,
            dataChannelOptions: { ordered: true },
            ProcessData: function (data) { onMessage(activeSession, data); },
            ProcessBinaryData: function (bytes) { if (source.session === activeSession && source.wantVideo && bytes) appendBinary(bytes); },
            xxStateChange: function (state) {
                if (source.session !== activeSession || activeSession.closing) return;
                if (state === 3) { source.retryCount = 0; setStatus('Connected; finding webcams…'); send({ cmd: 'enumerate' }); }
                else if (state === 0) {
                    source.wantVideo = false; source.starting = false; setStatus('Webcam connection interrupted; reconnecting…'); renderDevices();
                    if (source.retryTimer != null || source.retryCount >= 5) return;
                    var delay = Math.min(1000 * Math.pow(2, source.retryCount++), 10000);
                    source.retryTimer = root.setTimeout(function () { source.retryTimer = null; if (!source.closing) connect(nodeId, true); }, delay);
                }
            }
        };
        if (source.session) { source.session.closing = true; try { source.session.redirect.Stop(); } catch (e) { } }
        source.session = activeSession;
        source.nodeId = nodeId;
        activeSession.redirect = root.CreateAgentRedirect(root.meshserver, module, root.serverPublicNamePort, root.authCookie, root.authRelayCookie, root.domainUrl);
        activeSession.redirect.Start(nodeId);
        setStatus(reconnecting ? 'Reconnecting to the webcam…' : 'Connecting to the authenticated webcam tunnel…');
        renderDevices();
    }
    function startVideo() {
        var devices = element('mcwebcamDevices');
        var width = element('mcwebcamWidth');
        var height = element('mcwebcamHeight');
        var fps = element('mcwebcamFps');
        if (!devices || !devices.value || !connected()) { setStatus('Connect to the agent and select a webcam first.'); return; }
        source.selectedDeviceId = devices.value;
        source.width = parseInt(width.value, 10); source.height = parseInt(height.value, 10); source.fps = parseInt(fps.value, 10);
        source.captureStats = null; source.frameCount = 0; source.frameBytes = 0; source.lastFrameTime = 0; source.lateFrames = 0; source.maxGapMs = 0; source.pending = new Uint8Array(0); source.starting = true; source.wantVideo = true;
        renderDevices();
        if (!send({ cmd: 'start', deviceId: source.selectedDeviceId, width: source.width, height: source.height, fps: source.fps })) { source.starting = false; source.wantVideo = false; setStatus('The authenticated webcam tunnel is not connected.'); renderDevices(); return; }
        source.starting = false; setStatus('Starting webcam…'); renderDevices();
    }
    function open() {
        if (!root.currentNode || !root.currentNode._id || !root.currentNode.agent || (typeof root.isWindowsNode === 'function' && !root.isWindowsNode(root.currentNode))) return false;
        source.closing = false;
        var body = '<div class="mb-2"><label for="mcwebcamDevices" class="form-label">Webcam</label><select id="mcwebcamDevices" class="form-select" disabled></select></div>' +
            '<div class="row mb-2"><div class="col"><label for="mcwebcamWidth" class="form-label">Width</label><select id="mcwebcamWidth" class="form-select"><option value="320">320</option><option value="640" selected>640</option><option value="1280">1280</option></select></div>' +
            '<div class="col"><label for="mcwebcamHeight" class="form-label">Height</label><select id="mcwebcamHeight" class="form-select"><option value="240">240</option><option value="480" selected>480</option><option value="720">720</option></select></div>' +
            '<div class="col"><label for="mcwebcamFps" class="form-label">FPS</label><select id="mcwebcamFps" class="form-select"><option value="5">5</option><option value="10" selected>10</option><option value="15">15</option><option value="30">30</option></select></div></div>' +
            '<div class="d-flex gap-2 mb-2"><button id="mcwebcamStart" type="button" class="btn btn-primary" disabled>Start viewing</button><button id="mcwebcamStop" type="button" class="btn btn-secondary" disabled>Stop</button></div>' +
            '<div class="text-center bg-dark mb-2"><img id="mcwebcamImage" alt="Remote webcam" style="max-width:100%;max-height:55vh;display:block;margin:auto"></div>' +
            '<details class="small mb-2"><summary>Webcam diagnostics</summary><p id="mcwebcamDiagnostics" class="text-secondary mt-1 mb-0"></p></details><p id="mcwebcamStatus" class="mb-0" role="status"></p>';
        if (typeof root.setModalContent !== 'function' || typeof root.showModal !== 'function') return false;
        root.setModalContent('xxAddAgent', 'Remote webcam', body, 'small'); root.showModal('xxAddAgentModal', 'idx_dlgOkButton');
        var closeButton = element('idx_dlgOkButton'); if (closeButton) closeButton.textContent = 'Close';
        if (typeof root.QV === 'function') root.QV('idx_dlgCancelButton', false);
        element('mcwebcamStart').addEventListener('click', startVideo);
        element('mcwebcamStop').addEventListener('click', function () { stopVideo('Webcam stopped.'); });
        element('mcwebcamDevices').addEventListener('change', function () { source.selectedDeviceId = this.value; renderDevices(); });
        setStatus(source.status);
        if (!source.session || source.session.nodeId !== root.currentNode._id || !source.session.redirect || source.session.redirect.State === 0) connect(root.currentNode._id, false);
        else if (connected()) send({ cmd: 'enumerate' });
        renderDevices();
        return false;
    }
    function shutdown() {
        source.closing = true; source.wantVideo = false; source.starting = false; if (source.retryTimer != null) root.clearTimeout(source.retryTimer);
        if (source.session) { source.session.closing = true; try { source.session.redirect.sendText({ cmd: 'stop' }); } catch (e) { } try { source.session.redirect.Stop(); } catch (e) { } source.session = null; }
        if (source.imageUrl && root.URL) root.URL.revokeObjectURL(source.imageUrl); source.imageUrl = null;
    }
    root.mcwebcamViewMode = { open: open, desktopDisconnected: shutdown };
    root.addEventListener('beforeunload', shutdown);
})(window);
