using System;
using System.Collections.Generic;
using AOT;
using UnityEngine;
using UnityEngine.Scripting;
using Object = UnityEngine.Object;

namespace LiveKit
{
    public class HTMLVideoElement : HTMLMediaElement
    {
        public int VideoWidth
        {
            get
            {
                JSNative.PushString("videoWidth");
                return (int)JSNative.GetNumber(JSNative.GetProperty(NativeHandle));
            }
        }

        public int VideoHeight
        {
            get
            {
                JSNative.PushString("videoHeight");
                return (int)JSNative.GetNumber(JSNative.GetProperty(NativeHandle));
            }
        }

        [MonoPInvokeCallback(typeof(JSNative.JSDelegate))]
        private static void ResizeEvent(IntPtr ptr)
        {
            try
            {
                var handle = new JSHandle(ptr, true);
                if (!JSNative.IsObject(handle))
                    return;

                var el = Acquire<HTMLVideoElement>(handle);
                Log.Debug($"Received HTMLVideoElement.Resize {el.VideoWidth}x{el.VideoHeight}");

                if (el.VideoWidth == 0 || el.VideoHeight == 0)
                    Debug.LogError($"HTMLVideoElement.Resize - Wrong size: {el.VideoWidth}*{el.VideoHeight}");

                el.SetupTexture();
                el.VideoReceived?.Invoke(el.Texture);
            }
            catch (Exception e)
            {
                Log.Error($"Error happened on HTMLVideoElement.VideoReceived ( Is your listeners working correctly ? ): {Environment.NewLine} {e.Message}");
            }
        }

        public delegate void VideoReceivedDelegate(Texture2D tex);
        public event VideoReceivedDelegate VideoReceived;

        public Texture2D Texture { get; private set; }
        private readonly int m_TextureId;

        // Polled path, used when there is no WebGL context (WebGPU graphics API)
        private readonly int m_FrameId;
        private byte[] m_FrameBuffer;
        private bool m_GPUUpload; // Frames are copied on the GPU, otherwise read back through the CPU
        private bool m_Disposed;

        private bool UseCPUPath => m_FrameId != 0;

        [Preserve]
        internal HTMLVideoElement(JSHandle handle) : base(handle)
        {
            if (JSNative.IsWebGLContextAvailable())
            {
                m_TextureId = JSNative.NewTexture();
                SetupTexture();
                JSNative.AttachVideo(NativeHandle, m_TextureId);
            }
            else
            {
                m_FrameId = JSNative.AttachVideoCPU(NativeHandle);
                SetupTexture();
                VideoFrameUpdater.Register(this);
            }

            AddEventListener("resize", ResizeEvent);
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            m_Disposed = true;
            Object.Destroy(Texture);

            if (UseCPUPath)
                JSNative.DestroyVideoCPU(m_FrameId);
            else
                JSNative.DestroyTexture(m_TextureId);
        }

        void SetupTexture()
        {
            var width = VideoWidth > 0 ? VideoWidth : 1;
            var height = VideoHeight > 0 ? VideoHeight : 1;
            SetupTexture(width, height);
        }

        bool SetupTexture(int width, int height)
        {
            if (Texture != null)
            {
                if (UseCPUPath && Texture.width == width && Texture.height == height)
                    return false;

                Object.Destroy(Texture);
            }

            if (UseCPUPath)
            {
                Texture = new Texture2D(width, height, TextureFormat.RGBA32, false, true);
                Texture.Apply(false); // Creates the GPU resource so the native pointer is valid
                BindTexture();
            }
            else
            {
                Texture = Texture2D.CreateExternalTexture(width, height, TextureFormat.RGBA32, false, true, (IntPtr)m_TextureId);
            }
            return true;
        }

        void BindTexture()
        {
            m_GPUUpload = JSNative.BindVideoFrameTexture(m_FrameId, Texture.GetNativeTexturePtr());
            Log.Debug($"HTMLVideoElement: {Texture.width}x{Texture.height} video frames are copied on the {(m_GPUUpload ? "GPU" : "CPU")}");
        }

        void UpdateFrame()
        {
            if (!JSNative.UpdateVideoFrame(m_FrameId))
                return;

            var width = JSNative.GetVideoFrameWidth(m_FrameId);
            var height = JSNative.GetVideoFrameHeight(m_FrameId);
            if (width <= 0 || height <= 0)
                return;

            var resized = SetupTexture(width, height);

            if (m_GPUUpload && JSNative.UploadVideoFrameGPU(m_FrameId))
            {
                if (resized)
                    VideoReceived?.Invoke(Texture);
                return;
            }
            m_GPUUpload = false;

            var size = width * height * 4;
            if (m_FrameBuffer == null || m_FrameBuffer.Length != size)
                m_FrameBuffer = new byte[size];

            JSNative.CopyVideoFrame(m_FrameId, m_FrameBuffer, size);
            Texture.LoadRawTextureData(m_FrameBuffer);
            Texture.Apply(false);

            if (resized)
                VideoReceived?.Invoke(Texture);
        }

        // Uploads the CPU video frames from the player loop
        private class VideoFrameUpdater : MonoBehaviour
        {
            private static VideoFrameUpdater s_Instance;
            private static readonly List<WeakReference<HTMLVideoElement>> s_Elements = new List<WeakReference<HTMLVideoElement>>();

            internal static void Register(HTMLVideoElement element)
            {
                if (s_Instance == null)
                {
                    var go = new GameObject("LiveKitVideoFrameUpdater");
                    go.hideFlags = HideFlags.HideAndDontSave;
                    DontDestroyOnLoad(go);
                    s_Instance = go.AddComponent<VideoFrameUpdater>();
                }

                s_Elements.Add(new WeakReference<HTMLVideoElement>(element));
            }

            private void Update()
            {
                for (var i = s_Elements.Count - 1; i >= 0; i--)
                {
                    if (!s_Elements[i].TryGetTarget(out var element) || element.m_Disposed)
                    {
                        s_Elements.RemoveAt(i);
                        continue;
                    }

                    try
                    {
                        element.UpdateFrame();
                    }
                    catch (Exception e)
                    {
                        Log.Error($"Error happened on HTMLVideoElement.UpdateFrame: {Environment.NewLine} {e.Message}");
                    }
                }
            }
        }
    }
};
