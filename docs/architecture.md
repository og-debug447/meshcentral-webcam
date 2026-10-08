# Webcam architecture

## MeshCentral integration

MeshCentral's plugin API provides lifecycle hooks, Web UI exports, and an optional `modules_meshcore` file that is included in the MeshAgent JavaScript core. The current MeshCentral desktop toolbar does not expose a supported plugin button hook, so the project will use the same explicit ViewMode template anchor used by the working audio project: one **Webcam** button opens MeshCentral's standard modal. The patch will fail closed if those anchors change. It will not poll the DOM or inject an iframe.

The browser calls the existing `CreateAgentRedirect` with a reserved webcam protocol and ordered, reliable data-channel options. The server relay and agent rights checks remain the authorization boundary. The agent receives the relay's authenticated rights flags and accepts webcam commands only for an authorized remote-control or remote-view session; device IDs, formats, and frame sizes are validated on both sides.

## Native Windows capture

The Windows binding will use COM and Media Foundation. `MFEnumDeviceSources` enumerates active video capture devices and returns the friendly name plus the device symbolic link. A capture thread creates an `IMFMediaSource` and `IMFSourceReader`, chooses a supported video type, and reads `IMFSample` frames. Camera-provided `MFVideoFormat_MJPG` is preferred because each sample is already a browser-decodable JPEG image. When a camera only exposes raw video, the reader requests RGB32 and the binding encodes each frame with the Windows Imaging Component JPEG encoder (`IWICBitmapEncoder`), using only Windows SDK APIs.

The capture queue is bounded to three frames. If the relay or browser stalls, the oldest frame is discarded and the newest frame is retained. Capture shutdown signals the thread, waits for it, releases all COM objects, and reports device invalidation so the browser can retry enumeration. No camera frame is written to disk.

## Frame protocol

Each binary message starts with a fixed little-endian header:

| Field | Bytes | Meaning |
| --- | ---: | --- |
| magic | 4 | ASCII `MCWC` |
| version | 1 | Header version, initially `1` |
| flags | 1 | Reserved, must be zero |
| header length | 2 | Initially `16` |
| sequence | 4 | Monotonic frame number |
| payload length | 4 | JPEG byte count |

The browser rejects invalid headers, oversized payloads, and stale sequence numbers. It reassembles a message if the relay splits a binary fragment, then displays the complete JPEG with an object URL and revokes the previous URL after the new image loads. The maximum frame payload is bounded so it remains safe for the existing data channel; the UI will lower resolution or frame rate rather than silently exceed that limit.

## Format defaults

The implementation defaults to 640x480 at 10 FPS with camera-provided MJPEG preferred. The modal requests one of the bounded width, height, and frame-rate combinations accepted by the agent and reports the requested configuration. WIC uses its standard JPEG encoder settings for the raw-frame fallback. The UI calculates received frame rate and bytes/sec from actual frames.

## Verification boundary

Static checks validate plugin metadata, JavaScript syntax, frame-header parsing, patch idempotence, and the native x64/x86 Release compilation. Physical validation still requires a Windows camera: enumerate it, start capture, view frames alongside the desktop, unplug/replug the camera, test relay fallback, and confirm unauthorized sessions are rejected. This repository does not claim end-to-end webcam capture until those tests pass.
