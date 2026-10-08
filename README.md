# MeshCentral Webcam

Native Windows webcam viewing for MeshCentral PC Control. The project uses Windows Media Foundation and the Windows Imaging Component, and sends bounded JPEG video frames through MeshCentral's authenticated relay and existing agent WebRTC data channel.

The initial target is a live webcam panel alongside the remote desktop view:

- enumerate active cameras with friendly names and stable device IDs;
- select a camera, resolution, and frame rate;
- start and stop capture without opening a new listener port;
- show the stream in the authenticated MeshCentral browser session;
- recover from a camera disconnect and report capture, transport, and browser frame timing.

## Current status

The plugin, relay patcher, MeshAgent binding, browser controller, and frame protocol are present. The native Windows service builds for x64 and x86 with the Windows SDK. Physical camera capture and end-to-end MeshCentral installation still need to be exercised on a test endpoint.

The transport uses the same authenticated relay pattern as the MeshCentral Audio project, while the native capture path is separate: Media Foundation Source Reader for camera frames, preferring camera-provided MJPEG and falling back to Windows WIC JPEG encoding for raw frames. No FFmpeg, libvpx, libx264, libwebrtc, or third-party webcam library is used.

The browser receives a small binary frame header followed by one complete JPEG frame. A bounded queue drops old frames when the viewer is slower than the camera, keeping latency bounded instead of allowing an unbounded backlog.

See [docs/architecture.md](docs/architecture.md) for the researched integration points and verification boundary.

## Build and patch

From a Windows checkout of MeshAgent, run `node scripts/patch_meshagent.js C:\path\to\MeshAgent` and build the x86 and x64 `MeshService-2022` Release projects with Visual Studio. The patcher adds the native source/header and the required Windows Media Foundation/WIC import libraries; it does not change the upstream checkout's remote or publish binaries.

From a MeshCentral checkout, run `node scripts/patch_meshcentral.js C:\path\to\meshcentral`. The patcher installs the controller, adds protocol 16 to the existing relay and agent dispatch, and adds the toolbar button to both ViewMode templates. It is idempotent and stops with an error if the expected MeshCentral anchors have changed.
