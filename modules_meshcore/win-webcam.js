'use strict';

var FRAME_HEADER_BYTES = 16;
var MAX_FRAME_BYTES = 1024 * 1024;

function send(ws, value) {
    try { ws.write(JSON.stringify(value)); } catch (e) { }
}

function errorText(error) {
    var message = (error && typeof error.message === 'string') ? error.message : String(error);
    return message.substring(0, 256);
}

function validNumber(value, min, max) {
    return typeof value === 'number' && value === Math.floor(value) && value >= min && value <= max;
}

function stopCapture(ws) {
    var session = ws._mcwebcam;
    if (session == null) return;
    if (session.timer != null) { clearInterval(session.timer); session.timer = null; }
    if (session.capture != null) {
        try { session.capture.stop(); } catch (e) { }
        session.capture = null;
    }
    session.lastState = null;
}

function closeTunnel(ws) {
    stopCapture(ws);
    try { delete ws._mcwebcam; } catch (e) { ws._mcwebcam = null; }
}

function framePacket(sequence, frame) {
    if (!frame || frame.length < 4 || frame.length > MAX_FRAME_BYTES) return null;
    var packet = Buffer.alloc(FRAME_HEADER_BYTES + frame.length);
    packet.write('MCWC', 0, 4, 'ascii');
    packet.writeUInt8(1, 4);
    packet.writeUInt8(0, 5);
    packet.writeUInt16LE(FRAME_HEADER_BYTES, 6);
    packet.writeUInt32LE(sequence >>> 0, 8);
    packet.writeUInt32LE(frame.length >>> 0, 12);
    frame.copy(packet, FRAME_HEADER_BYTES);
    return packet;
}

function handleTunnelData(ws, data) {
    if (process.platform !== 'win32') { send(ws, { type: 'error', message: 'Windows webcam capture is required.' }); return; }
    var message;
    try { message = JSON.parse((typeof data === 'string') ? data : data.toString()); } catch (e) { return; }
    if (message == null || typeof message.cmd !== 'string') return;

    if (message.cmd === 'enumerate') {
        try { send(ws, { type: 'devices', devices: require('webcam').enumerate() }); }
        catch (e) { send(ws, { type: 'error', operation: 'enumerate', message: 'Could not enumerate Windows cameras.' }); }
        return;
    }
    if (message.cmd === 'stop') {
        stopCapture(ws);
        send(ws, { type: 'state', state: 'stopped', message: 'Webcam stopped.' });
        return;
    }
    if (message.cmd !== 'start' || typeof message.deviceId !== 'string' || message.deviceId.length < 1 || message.deviceId.length > 4096 ||
        !validNumber(message.width === undefined ? 640 : message.width, 160, 1920) ||
        !validNumber(message.height === undefined ? 480 : message.height, 120, 1080) ||
        !validNumber(message.fps === undefined ? 10 : message.fps, 1, 30)) {
        send(ws, { type: 'error', operation: 'start', message: 'Invalid webcam device or format.' });
        return;
    }

    var width = message.width === undefined ? 640 : message.width;
    var height = message.height === undefined ? 480 : message.height;
    var fps = message.fps === undefined ? 10 : message.fps;
    stopCapture(ws);
    var session = null;
    try {
        var webcam = require('webcam');
        var devices = webcam.enumerate();
        if (!devices.some(function (device) { return device && device.id === message.deviceId; })) {
            send(ws, { type: 'error', operation: 'start', message: 'The selected webcam is unavailable.' });
            return;
        }
        session = {
            capture: webcam.createCapture(message.deviceId, width, height, fps),
            timer: null, lastState: null, blocked: false, sequence: 0,
            width: width, height: height, fps: fps,
            stats: { polls: 0, emptyReads: 0, blockedPolls: 0, frames: 0, bytes: 0, latePolls: 0, maxIntervalMs: 0, windowStart: Date.now() },
            lastPollTime: 0
        };
        ws._mcwebcam = session;
        session.capture.start();
        session.timer = setInterval(function () {
            if (ws._mcwebcam !== session) return;
            var now = Date.now();
            session.stats.polls++;
            if (session.lastPollTime !== 0) {
                var intervalMs = now - session.lastPollTime;
                if (intervalMs > session.stats.maxIntervalMs) session.stats.maxIntervalMs = intervalMs;
                if (intervalMs > 30) session.stats.latePolls++;
            }
            session.lastPollTime = now;
            var state;
            try { state = session.capture.getState(); } catch (e) { state = 'error'; }
            if (state !== session.lastState) {
                session.lastState = state;
                send(ws, { type: 'state', state: state, width: session.width, height: session.height, fps: session.fps, message: state === 'device-lost' ? 'The webcam disconnected; waiting for it to return.' : (state === 'reconnected' ? 'The webcam reconnected.' : state) });
            }
            if (state === 'error') {
                send(ws, { type: 'error', operation: 'capture', message: 'Windows webcam capture failed.' });
                stopCapture(ws);
                return;
            }
            if (session.blocked) {
                session.stats.blockedPolls++;
                if (session.stats.polls >= 200) sendStats(ws, session);
                return;
            }
            var frame;
            try { frame = session.capture.read(); } catch (e) { frame = null; }
            if (frame == null || frame.length === 0) {
                session.stats.emptyReads++;
                if (session.stats.polls >= 200) sendStats(ws, session);
                return;
            }
            var packet = framePacket(session.sequence++, frame);
            if (packet == null) {
                session.stats.emptyReads++;
                if (session.stats.polls >= 200) sendStats(ws, session);
                return;
            }
            session.stats.frames++;
            session.stats.bytes += frame.length;
            try {
                if (ws.write(packet) === false) {
                    session.blocked = true;
                    ws.once('drain', function () { if (ws._mcwebcam === session) session.blocked = false; });
                }
            } catch (e) { session.blocked = true; }
            if (session.stats.polls >= 200) sendStats(ws, session);
        }, 10);
    } catch (e) {
        if (session != null && ws._mcwebcam === session) {
            stopCapture(ws);
            try { delete ws._mcwebcam; } catch (ignore) { ws._mcwebcam = null; }
        }
        send(ws, { type: 'error', operation: 'start', message: 'Could not start Windows webcam capture: ' + errorText(e) });
    }
}

function sendStats(ws, session) {
    var stats = session.stats;
    send(ws, {
        type: 'captureStats',
        elapsedMs: Date.now() - stats.windowStart,
        polls: stats.polls,
        emptyReads: stats.emptyReads,
        blockedPolls: stats.blockedPolls,
        latePolls: stats.latePolls,
        maxIntervalMs: stats.maxIntervalMs,
        frames: stats.frames,
        bytes: stats.bytes,
        fps: session.fps
    });
    session.stats = { polls: 0, emptyReads: 0, blockedPolls: 0, frames: 0, bytes: 0, latePolls: 0, maxIntervalMs: 0, windowStart: Date.now() };
}

module.exports = { handleTunnelData: handleTunnelData, closeTunnel: closeTunnel, framePacket: framePacket };
