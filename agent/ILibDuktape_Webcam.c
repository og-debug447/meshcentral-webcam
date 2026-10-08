/* Native Windows webcam capture for MeshAgent. */
#include "ILibDuktape_Webcam.h"
#include "ILibDuktape_Helpers.h"
#include "ILibDuktapeModSearch.h"

#ifdef WIN32
#define COBJMACROS
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <wincodec.h>
#include <objidl.h>
#include <propidl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "windowscodecs.lib")

#define WEBCAM_CAPTURE_PTR "\xFF_webcam_capture"
#define WEBCAM_QUEUE_SLOTS 3
#define WEBCAM_MAX_FRAME_BYTES (1024 * 1024)

typedef enum WebcamState
{
    WEBCAM_STATE_STOPPED = 0,
    WEBCAM_STATE_STARTING = 1,
    WEBCAM_STATE_RUNNING = 2,
    WEBCAM_STATE_DEVICE_LOST = 3,
    WEBCAM_STATE_RECONNECTED = 4,
    WEBCAM_STATE_ERROR = 5
} WebcamState;

typedef struct WebcamFrame
{
    BYTE *data;
    DWORD size;
} WebcamFrame;

typedef struct WebcamCapture
{
    HANDLE thread;
    HANDLE stopEvent;
    CRITICAL_SECTION lock;
    wchar_t *deviceId;
    int requestedWidth;
    int requestedHeight;
    int requestedFps;
    int width;
    int height;
    int fps;
    volatile LONG state;
    WebcamFrame queue[WEBCAM_QUEUE_SLOTS];
    int readIndex;
    int writeIndex;
    int frameCount;
} WebcamCapture;

/* IMFMediaSource is not exported by uuid.lib in all supported SDK layouts. */
static const IID MCWEBCAM_IID_IMFMediaSource = { 0x279a808d, 0xaec7, 0x40c8, { 0x9c, 0x6b, 0xa6, 0xb4, 0x92, 0xc7, 0x8a, 0x66 } };

static void Webcam_SetState(WebcamCapture *capture, WebcamState state)
{
    InterlockedExchange(&capture->state, (LONG)state);
}

static const char *Webcam_StateString(LONG state)
{
    switch ((WebcamState)state)
    {
        case WEBCAM_STATE_STARTING: return "starting";
        case WEBCAM_STATE_RUNNING: return "running";
        case WEBCAM_STATE_DEVICE_LOST: return "device-lost";
        case WEBCAM_STATE_RECONNECTED: return "reconnected";
        case WEBCAM_STATE_ERROR: return "error";
        default: return "stopped";
    }
}

static wchar_t *Webcam_Utf8ToWide(const char *value, int length)
{
    int count;
    wchar_t *ret;
    if (value == NULL || length < 1 || length > 4096) return NULL;
    count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, length, NULL, 0);
    if (count <= 0) return NULL;
    ret = (wchar_t*)malloc(sizeof(wchar_t) * (count + 1));
    if (ret == NULL) return NULL;
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, length, ret, count) != count) { free(ret); return NULL; }
    ret[count] = 0;
    return ret;
}

static void Webcam_PushWide(duk_context *ctx, const wchar_t *value)
{
    int count = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    char *utf8;
    if (count <= 0) { duk_push_string(ctx, ""); return; }
    utf8 = (char*)malloc((size_t)count);
    if (utf8 == NULL) { duk_push_string(ctx, ""); return; }
    if (WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8, count, NULL, NULL) != count) { free(utf8); duk_push_string(ctx, ""); return; }
    duk_push_lstring(ctx, utf8, (duk_size_t)(count - 1));
    free(utf8);
}

static HRESULT Webcam_InitializeCom(BOOL *uninitialize)
{
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    *uninitialize = SUCCEEDED(hr);
    if (hr == RPC_E_CHANGED_MODE) return S_OK;
    return hr;
}

static HRESULT Webcam_CreateVideoAttributes(IMFAttributes **attributes)
{
    HRESULT hr = MFCreateAttributes(attributes, 2);
    if (SUCCEEDED(hr)) hr = IMFAttributes_SetGUID(*attributes, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
    return hr;
}

static HRESULT Webcam_EnumerateActivates(IMFActivate ***activates, UINT32 *count)
{
    IMFAttributes *attributes = NULL;
    HRESULT hr = Webcam_CreateVideoAttributes(&attributes);
    if (SUCCEEDED(hr)) hr = MFEnumDeviceSources(attributes, activates, count);
    if (attributes) IMFAttributes_Release(attributes);
    return hr;
}

static duk_ret_t Webcam_Enumerate(duk_context *ctx)
{
    BOOL uninitialize = FALSE;
    BOOL mfStarted = FALSE;
    IMFActivate **activates = NULL;
    UINT32 count = 0, i, outCount = 0;
    HRESULT hr;

    hr = Webcam_InitializeCom(&uninitialize);
    if (FAILED(hr)) return ILibDuktape_Error(ctx, "Could not initialize Windows camera services");
    hr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    if (SUCCEEDED(hr))
    {
        mfStarted = TRUE;
        hr = Webcam_EnumerateActivates(&activates, &count);
    }
    if (FAILED(hr))
    {
        if (activates) CoTaskMemFree(activates);
        if (mfStarted) MFShutdown();
        if (uninitialize) CoUninitialize();
        return ILibDuktape_Error(ctx, "Could not enumerate Windows cameras");
    }

    duk_push_array(ctx);
    for (i = 0; i < count; ++i)
    {
        WCHAR *id = NULL, *name = NULL;
        UINT32 idLength = 0, nameLength = 0;
        if (SUCCEEDED(IMFActivate_GetAllocatedString(activates[i], &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &id, &idLength)) &&
            SUCCEEDED(IMFActivate_GetAllocatedString(activates[i], &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &nameLength)))
        {
            duk_push_object(ctx);
            Webcam_PushWide(ctx, id);
            duk_put_prop_string(ctx, -2, "id");
            Webcam_PushWide(ctx, name);
            duk_put_prop_string(ctx, -2, "name");
            duk_put_prop_index(ctx, -2, outCount++);
        }
        if (id) CoTaskMemFree(id);
        if (name) CoTaskMemFree(name);
        IMFActivate_Release(activates[i]);
    }
    CoTaskMemFree(activates);
    if (mfStarted) MFShutdown();
    if (uninitialize) CoUninitialize();
    return 1;
}

static void Webcam_FreeFrame(WebcamFrame *frame)
{
    if (frame->data) free(frame->data);
    frame->data = NULL;
    frame->size = 0;
}

static void Webcam_ClearQueue(WebcamCapture *capture)
{
    int i;
    EnterCriticalSection(&capture->lock);
    for (i = 0; i < WEBCAM_QUEUE_SLOTS; ++i) Webcam_FreeFrame(&capture->queue[i]);
    capture->readIndex = capture->writeIndex = capture->frameCount = 0;
    LeaveCriticalSection(&capture->lock);
}

static void Webcam_PushFrame(WebcamCapture *capture, const BYTE *data, DWORD size)
{
    BYTE *copy;
    WebcamFrame *slot;
    if (data == NULL || size < 4 || size > WEBCAM_MAX_FRAME_BYTES) return;
    copy = (BYTE*)malloc(size);
    if (copy == NULL) return;
    memcpy(copy, data, size);
    EnterCriticalSection(&capture->lock);
    if (capture->frameCount == WEBCAM_QUEUE_SLOTS)
    {
        Webcam_FreeFrame(&capture->queue[capture->readIndex]);
        capture->readIndex = (capture->readIndex + 1) % WEBCAM_QUEUE_SLOTS;
        --capture->frameCount;
    }
    slot = &capture->queue[capture->writeIndex];
    Webcam_FreeFrame(slot);
    slot->data = copy;
    slot->size = size;
    capture->writeIndex = (capture->writeIndex + 1) % WEBCAM_QUEUE_SLOTS;
    ++capture->frameCount;
    LeaveCriticalSection(&capture->lock);
}

static HRESULT Webcam_FindSource(const wchar_t *deviceId, IMFMediaSource **mediaSource)
{
    IMFActivate **activates = NULL;
    UINT32 count = 0, i;
    HRESULT hr = Webcam_EnumerateActivates(&activates, &count);
    if (FAILED(hr)) return hr;
    hr = MF_E_NOT_FOUND;
    for (i = 0; i < count; ++i)
    {
        WCHAR *id = NULL;
        UINT32 length = 0;
        if (SUCCEEDED(IMFActivate_GetAllocatedString(activates[i], &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &id, &length)))
        {
            if (wcscmp(id, deviceId) == 0) hr = IMFActivate_ActivateObject(activates[i], &MCWEBCAM_IID_IMFMediaSource, (void**)mediaSource);
            CoTaskMemFree(id);
        }
        IMFActivate_Release(activates[i]);
        if (SUCCEEDED(hr)) { ++i; break; }
    }
    for (; i < count; ++i) IMFActivate_Release(activates[i]);
    CoTaskMemFree(activates);
    return hr;
}

static int Webcam_TypeIsMjpg(IMFMediaType *type)
{
    GUID subtype;
    return SUCCEEDED(IMFMediaType_GetGUID(type, &MF_MT_SUBTYPE, &subtype)) && IsEqualGUID(&subtype, &MFVideoFormat_MJPG);
}

/* These helpers are inline-only in the Windows C++ headers, so keep the C
 * implementation independent of the SDK's C++ inline definitions. */
static HRESULT Webcam_GetAttributeSize(IMFAttributes *attributes, REFGUID key, UINT32 *width, UINT32 *height)
{
    UINT64 packed = 0;
    HRESULT hr = IMFAttributes_GetUINT64(attributes, key, &packed);
    if (SUCCEEDED(hr))
    {
        *width = (UINT32)(packed >> 32);
        *height = (UINT32)(packed & 0xFFFFFFFFULL);
    }
    return hr;
}

static HRESULT Webcam_SetAttributeSize(IMFAttributes *attributes, REFGUID key, UINT32 width, UINT32 height)
{
    return IMFAttributes_SetUINT64(attributes, key, (((UINT64)width) << 32) | (UINT64)height);
}

static HRESULT Webcam_GetAttributeRatio(IMFAttributes *attributes, REFGUID key, UINT32 *numerator, UINT32 *denominator)
{
    return Webcam_GetAttributeSize(attributes, key, numerator, denominator);
}

static HRESULT Webcam_SetAttributeRatio(IMFAttributes *attributes, REFGUID key, UINT32 numerator, UINT32 denominator)
{
    return Webcam_SetAttributeSize(attributes, key, numerator, denominator);
}

static HRESULT Webcam_TypeSize(IMFMediaType *type, int *width, int *height)
{
    UINT32 w = 0, h = 0;
    HRESULT hr = Webcam_GetAttributeSize((IMFAttributes*)type, &MF_MT_FRAME_SIZE, &w, &h);
    if (SUCCEEDED(hr)) { *width = (int)w; *height = (int)h; }
    return hr;
}

static HRESULT Webcam_SelectType(IMFSourceReader *reader, WebcamCapture *capture, int *mjpg)
{
    IMFMediaType *best = NULL, *native = NULL, *requested = NULL, *current = NULL;
    DWORD index = 0;
    int bestScore = 0x7FFFFFFF, w, h, score;
    HRESULT hr;
    *mjpg = 0;

    while (SUCCEEDED(IMFSourceReader_GetNativeMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, index++, &native)))
    {
        if (Webcam_TypeIsMjpg(native) && SUCCEEDED(Webcam_TypeSize(native, &w, &h)))
        {
            score = abs(w - capture->requestedWidth) + abs(h - capture->requestedHeight);
            if (best == NULL || score < bestScore)
            {
                if (best) IMFMediaType_Release(best);
                best = native;
                bestScore = score;
                native = NULL;
            }
        }
        if (native) IMFMediaType_Release(native);
        native = NULL;
    }
    if (best)
    {
        hr = IMFSourceReader_SetCurrentMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, NULL, best);
        if (SUCCEEDED(hr)) *mjpg = 1;
        IMFMediaType_Release(best);
        if (SUCCEEDED(hr)) goto selected;
    }

    hr = MFCreateMediaType(&requested);
    if (SUCCEEDED(hr)) hr = IMFMediaType_SetGUID(requested, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
    if (SUCCEEDED(hr)) hr = IMFMediaType_SetGUID(requested, &MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
    if (SUCCEEDED(hr)) hr = Webcam_SetAttributeSize((IMFAttributes*)requested, &MF_MT_FRAME_SIZE, (UINT32)capture->requestedWidth, (UINT32)capture->requestedHeight);
    if (SUCCEEDED(hr)) hr = Webcam_SetAttributeRatio((IMFAttributes*)requested, &MF_MT_FRAME_RATE, (UINT32)capture->requestedFps, 1);
    if (SUCCEEDED(hr)) hr = IMFSourceReader_SetCurrentMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, NULL, requested);
    if (requested) IMFMediaType_Release(requested);
    if (SUCCEEDED(hr)) goto selected;

    index = 0;
    while (SUCCEEDED(IMFSourceReader_GetNativeMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, index++, &native)))
    {
        hr = IMFSourceReader_SetCurrentMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, NULL, native);
        IMFMediaType_Release(native);
        native = NULL;
        if (SUCCEEDED(hr)) { *mjpg = 0; goto selected; }
    }
    return hr;

selected:
    hr = IMFSourceReader_GetCurrentMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, &current);
    if (SUCCEEDED(hr))
    {
        Webcam_TypeSize(current, &capture->width, &capture->height);
        UINT32 numerator = 0, denominator = 0;
        if (SUCCEEDED(Webcam_GetAttributeRatio((IMFAttributes*)current, &MF_MT_FRAME_RATE, &numerator, &denominator)) && denominator != 0) capture->fps = (int)(numerator / denominator);
        if (capture->fps < 1) capture->fps = capture->requestedFps;
        IMFMediaType_Release(current);
    }
    return hr;
}

static HRESULT Webcam_EncodeRgb32(const BYTE *pixels, int width, int height, BYTE **output, DWORD *outputSize)
{
    IWICImagingFactory *factory = NULL;
    IWICBitmapEncoder *encoder = NULL;
    IWICBitmapFrameEncode *frame = NULL;
    IPropertyBag2 *options = NULL;
    IStream *stream = NULL;
    HGLOBAL global = NULL;
    BYTE *encoded = NULL, *mapped = NULL;
    SIZE_T size;
    GUID pixelFormat = GUID_WICPixelFormat32bppBGRA;
    HRESULT hr;
    *output = NULL; *outputSize = 0;

    hr = CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER, &IID_IWICImagingFactory, (void**)&factory);
    if (SUCCEEDED(hr)) hr = CreateStreamOnHGlobal(NULL, TRUE, &stream);
    if (SUCCEEDED(hr)) hr = IWICImagingFactory_CreateEncoder(factory, &GUID_ContainerFormatJpeg, NULL, &encoder);
    if (SUCCEEDED(hr)) hr = IWICBitmapEncoder_Initialize(encoder, stream, WICBitmapEncoderNoCache);
    if (SUCCEEDED(hr)) hr = IWICBitmapEncoder_CreateNewFrame(encoder, &frame, &options);
    if (options) IPropertyBag2_Release(options);
    if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_Initialize(frame, NULL);
    if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_SetSize(frame, (UINT)width, (UINT)height);
    if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_SetPixelFormat(frame, &pixelFormat);
    if (SUCCEEDED(hr) && !IsEqualGUID(&pixelFormat, &GUID_WICPixelFormat32bppBGRA)) hr = WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT;
    if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_WritePixels(frame, (UINT)height, (UINT)(width * 4), (UINT)(width * height * 4), (BYTE*)pixels);
    if (SUCCEEDED(hr)) hr = IWICBitmapFrameEncode_Commit(frame);
    if (SUCCEEDED(hr)) hr = IWICBitmapEncoder_Commit(encoder);
    if (SUCCEEDED(hr)) hr = GetHGlobalFromStream(stream, &global);
    if (SUCCEEDED(hr))
    {
        size = GlobalSize(global);
        if (size < 4 || size > WEBCAM_MAX_FRAME_BYTES) hr = E_FAIL;
        else
        {
            mapped = (BYTE*)GlobalLock(global);
            if (mapped == NULL) hr = E_FAIL;
            else
            {
                encoded = (BYTE*)malloc(size);
                if (encoded == NULL) hr = E_OUTOFMEMORY;
                else { memcpy(encoded, mapped, size); *output = encoded; *outputSize = (DWORD)size; }
                GlobalUnlock(global);
            }
        }
    }
    if (FAILED(hr) && encoded) free(encoded);
    if (frame) IWICBitmapFrameEncode_Release(frame);
    if (encoder) IWICBitmapEncoder_Release(encoder);
    if (stream) stream->lpVtbl->Release(stream);
    if (factory) IWICImagingFactory_Release(factory);
    return hr;
}

static HRESULT Webcam_CaptureOnce(WebcamCapture *capture, BOOL reconnected)
{
    BOOL uninitialize = FALSE;
    IMFMediaSource *mediaSource = NULL;
    IMFSourceReader *reader = NULL;
    IMFSample *sample = NULL;
    IMFMediaBuffer *buffer = NULL;
    BYTE *data = NULL, *encoded = NULL;
    DWORD maxLength = 0, currentLength = 0, flags = 0;
    DWORD actualStream = 0;
    LONGLONG timestamp = 0;
    int mjpg = 0;
    HRESULT hr = Webcam_InitializeCom(&uninitialize);
    if (FAILED(hr)) return hr;
    hr = Webcam_FindSource(capture->deviceId, &mediaSource);
    if (SUCCEEDED(hr)) hr = MFCreateSourceReaderFromMediaSource(mediaSource, NULL, &reader);
    if (SUCCEEDED(hr)) hr = Webcam_SelectType(reader, capture, &mjpg);
    if (SUCCEEDED(hr)) Webcam_SetState(capture, reconnected ? WEBCAM_STATE_RECONNECTED : WEBCAM_STATE_RUNNING);
    while (SUCCEEDED(hr) && WaitForSingleObject(capture->stopEvent, 0) != WAIT_OBJECT_0)
    {
        if (sample) { IMFSample_Release(sample); sample = NULL; }
        hr = IMFSourceReader_ReadSample(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &actualStream, &flags, &timestamp, &sample);
        if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) break;
        if (sample == NULL || (flags & MF_SOURCE_READERF_STREAMTICK) != 0) continue;
        hr = IMFSample_ConvertToContiguousBuffer(sample, &buffer);
        if (FAILED(hr)) break;
        hr = IMFMediaBuffer_Lock(buffer, &data, &maxLength, &currentLength);
        if (SUCCEEDED(hr))
        {
            if (mjpg) Webcam_PushFrame(capture, data, currentLength);
            else if (SUCCEEDED(Webcam_EncodeRgb32(data, capture->width, capture->height, &encoded, &currentLength)))
            {
                Webcam_PushFrame(capture, encoded, currentLength);
                free(encoded); encoded = NULL;
            }
            IMFMediaBuffer_Unlock(buffer);
        }
        IMFMediaBuffer_Release(buffer); buffer = NULL;
    }
    if (sample) IMFSample_Release(sample);
    if (buffer) IMFMediaBuffer_Release(buffer);
    if (encoded) free(encoded);
    if (reader) IMFSourceReader_Release(reader);
    if (mediaSource) IMFMediaSource_Shutdown(mediaSource);
    if (mediaSource) IMFMediaSource_Release(mediaSource);
    if (uninitialize) CoUninitialize();
    return hr;
}

static DWORD WINAPI Webcam_CaptureThread(LPVOID arg)
{
    WebcamCapture *capture = (WebcamCapture*)arg;
    BOOL reconnected = FALSE;
    HRESULT startup = MFStartup(MF_VERSION, MFSTARTUP_FULL);
    if (FAILED(startup)) { Webcam_SetState(capture, WEBCAM_STATE_ERROR); return 0; }
    for (;;)
    {
        HRESULT hr = Webcam_CaptureOnce(capture, reconnected);
        if (WaitForSingleObject(capture->stopEvent, 0) == WAIT_OBJECT_0) break;
        if (hr == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED || hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) || hr == MF_E_NOT_FOUND)
        {
            Webcam_ClearQueue(capture);
            Webcam_SetState(capture, WEBCAM_STATE_DEVICE_LOST);
            if (WaitForSingleObject(capture->stopEvent, 1000) == WAIT_OBJECT_0) break;
            reconnected = TRUE;
            continue;
        }
        Webcam_SetState(capture, WEBCAM_STATE_ERROR);
        break;
    }
    MFShutdown();
    if (WaitForSingleObject(capture->stopEvent, 0) == WAIT_OBJECT_0) Webcam_SetState(capture, WEBCAM_STATE_STOPPED);
    return 0;
}

static WebcamCapture *Webcam_GetCapture(duk_context *ctx, duk_idx_t index)
{
    return (WebcamCapture*)Duktape_GetPointerProperty(ctx, index, WEBCAM_CAPTURE_PTR);
}

static WebcamCapture *Webcam_GetThisCapture(duk_context *ctx)
{
    WebcamCapture *capture;
    duk_push_this(ctx);
    capture = Webcam_GetCapture(ctx, -1);
    duk_pop(ctx);
    return capture;
}

static duk_ret_t Webcam_CaptureStart(duk_context *ctx)
{
    WebcamCapture *capture = Webcam_GetThisCapture(ctx);
    if (capture == NULL) return ILibDuktape_Error(ctx, "Webcam capture is closed");
    if (capture->thread != NULL) { duk_push_true(ctx); return 1; }
    ResetEvent(capture->stopEvent);
    Webcam_SetState(capture, WEBCAM_STATE_STARTING);
    capture->thread = CreateThread(NULL, 0, Webcam_CaptureThread, capture, 0, NULL);
    if (capture->thread == NULL) { Webcam_SetState(capture, WEBCAM_STATE_ERROR); return ILibDuktape_Error(ctx, "Could not start webcam capture thread"); }
    duk_push_true(ctx);
    return 1;
}

static duk_ret_t Webcam_CaptureStop(duk_context *ctx)
{
    WebcamCapture *capture = Webcam_GetThisCapture(ctx);
    if (capture == NULL) { duk_push_false(ctx); return 1; }
    SetEvent(capture->stopEvent);
    if (capture->thread != NULL)
    {
        WaitForSingleObject(capture->thread, INFINITE);
        CloseHandle(capture->thread);
        capture->thread = NULL;
    }
    Webcam_ClearQueue(capture);
    Webcam_SetState(capture, WEBCAM_STATE_STOPPED);
    duk_push_true(ctx);
    return 1;
}

static duk_ret_t Webcam_CaptureState(duk_context *ctx)
{
    WebcamCapture *capture = Webcam_GetThisCapture(ctx);
    if (capture == NULL) duk_push_string(ctx, "error");
    else duk_push_string(ctx, Webcam_StateString(InterlockedCompareExchange(&capture->state, 0, 0)));
    return 1;
}

static duk_ret_t Webcam_CaptureRead(duk_context *ctx)
{
    WebcamCapture *capture = Webcam_GetThisCapture(ctx);
    WebcamFrame frame = { 0 };
    void *buffer;
    if (capture == NULL) return ILibDuktape_Error(ctx, "Webcam capture is closed");
    EnterCriticalSection(&capture->lock);
    if (capture->frameCount > 0)
    {
        frame = capture->queue[capture->readIndex];
        capture->queue[capture->readIndex].data = NULL;
        capture->queue[capture->readIndex].size = 0;
        capture->readIndex = (capture->readIndex + 1) % WEBCAM_QUEUE_SLOTS;
        --capture->frameCount;
    }
    LeaveCriticalSection(&capture->lock);
    duk_push_buffer_raw(ctx, (duk_size_t)frame.size, DUK_BUF_FLAG_DYNAMIC);
    buffer = duk_get_buffer_data(ctx, -1, NULL);
    if (frame.size > 0 && buffer != NULL) memcpy(buffer, frame.data, frame.size);
    if (frame.data) free(frame.data);
    duk_push_buffer_object(ctx, -1, 0, (duk_size_t)frame.size, DUK_BUFOBJ_NODEJS_BUFFER);
    duk_remove(ctx, -2);
    return 1;
}

static duk_ret_t Webcam_CaptureFinalizer(duk_context *ctx)
{
    WebcamCapture *capture = Webcam_GetCapture(ctx, 0);
    if (capture != NULL)
    {
        SetEvent(capture->stopEvent);
        if (capture->thread != NULL) { WaitForSingleObject(capture->thread, INFINITE); CloseHandle(capture->thread); }
        Webcam_ClearQueue(capture);
        CloseHandle(capture->stopEvent);
        DeleteCriticalSection(&capture->lock);
        free(capture->deviceId);
        duk_push_pointer(ctx, NULL);
        duk_put_prop_string(ctx, 0, WEBCAM_CAPTURE_PTR);
        free(capture);
    }
    return 0;
}

static duk_ret_t Webcam_CreateCapture(duk_context *ctx)
{
    const char *id;
    duk_size_t idLength;
    int width, height, fps;
    WebcamCapture *capture;
    if (!duk_is_string(ctx, 0)) return ILibDuktape_Error(ctx, "webcam.createCapture(deviceId, width, height, fps) requires a device ID");
    width = duk_get_int_default(ctx, 1, 640);
    height = duk_get_int_default(ctx, 2, 480);
    fps = duk_get_int_default(ctx, 3, 10);
    if (width < 160 || width > 1920 || height < 120 || height > 1080 || fps < 1 || fps > 30) return ILibDuktape_Error(ctx, "Unsupported webcam format");
    id = duk_get_lstring(ctx, 0, &idLength);
    if (idLength < 1 || idLength > 4096) return ILibDuktape_Error(ctx, "Webcam device ID length is invalid");
    capture = (WebcamCapture*)calloc(1, sizeof(WebcamCapture));
    if (capture == NULL) return ILibDuktape_Error(ctx, "Out of memory");
    capture->deviceId = Webcam_Utf8ToWide(id, (int)idLength);
    capture->requestedWidth = width;
    capture->requestedHeight = height;
    capture->requestedFps = fps;
    capture->width = width;
    capture->height = height;
    capture->fps = fps;
    capture->stopEvent = CreateEventW(NULL, TRUE, TRUE, NULL);
    if (capture->deviceId == NULL || capture->stopEvent == NULL)
    {
        if (capture->stopEvent) CloseHandle(capture->stopEvent);
        free(capture->deviceId); free(capture);
        return ILibDuktape_Error(ctx, "Could not allocate webcam capture state");
    }
    InitializeCriticalSection(&capture->lock);
    capture->state = WEBCAM_STATE_STOPPED;
    duk_push_object(ctx);
    duk_push_pointer(ctx, capture);
    duk_put_prop_string(ctx, -2, WEBCAM_CAPTURE_PTR);
    ILibDuktape_CreateInstanceMethod(ctx, "start", Webcam_CaptureStart, 0);
    ILibDuktape_CreateInstanceMethod(ctx, "stop", Webcam_CaptureStop, 0);
    ILibDuktape_CreateInstanceMethod(ctx, "getState", Webcam_CaptureState, 0);
    ILibDuktape_CreateInstanceMethod(ctx, "read", Webcam_CaptureRead, 0);
    ILibDuktape_CreateFinalizer(ctx, Webcam_CaptureFinalizer);
    return 1;
}

static void Webcam_Push(duk_context *ctx, void *chain)
{
    (void)chain;
    duk_push_object(ctx);
    duk_push_c_function(ctx, Webcam_Enumerate, 0);
    duk_put_prop_string(ctx, -2, "enumerate");
    duk_push_c_function(ctx, Webcam_CreateCapture, 4);
    duk_put_prop_string(ctx, -2, "createCapture");
}

void ILibDuktape_Webcam_Init(duk_context *ctx)
{
    ILibDuktape_ModSearch_AddHandler(ctx, "webcam", Webcam_Push);
}

#else
static duk_ret_t Webcam_Unsupported(duk_context *ctx)
{
    return ILibDuktape_Error(ctx, "Windows webcam capture is only available on Windows");
}
static void Webcam_Push(duk_context *ctx, void *chain)
{
    (void)chain;
    duk_push_object(ctx);
    duk_push_c_function(ctx, Webcam_Unsupported, DUK_VARARGS);
    duk_put_prop_string(ctx, -2, "enumerate");
    duk_push_c_function(ctx, Webcam_Unsupported, DUK_VARARGS);
    duk_put_prop_string(ctx, -2, "createCapture");
}
void ILibDuktape_Webcam_Init(duk_context *ctx)
{
    ILibDuktape_ModSearch_AddHandler(ctx, "webcam", Webcam_Push);
}
#endif
