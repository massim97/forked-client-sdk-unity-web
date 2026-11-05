var NativeLib = {
    $LKBridge: {
        Data: null, // Map<number, object>
        Pointers: null, // Map<object, number>
        RefCount: null, // Map<number, number>
        Debug: false,
        RefIndex: 1,
        Stack: [],
        StackCSharp: [],
        FunctionInstance: null, // Current instance in a callback ( = this )
        NullPtr: 0,
        VideoFrames: null, // Map<number, object> (CPU video path, used when there is no WebGL context)
        NextVideoFrameId: 1,

        PrepareVideo: function (videoPtr) {
            var video = LKBridge.Data.get(videoPtr);
            video.style.opacity = 0;
            video.style.width = 0;
            video.style.height = 0;
            setTimeout(function() {
                video.play();
            }, 0)
            video.addEventListener("canplay", (event) => {
                video.play();
            });

            document.body.appendChild(video);
            return video;
        },

        // Runtime.dynCall and the global dynCall no longer exist from Unity 6 (Emscripten 3.x).
        // makeDynCall is expanded at build time, so it needs a literal signature: only 'vi' is used.
        DynCall: function (sig, fnc, args) {
            if (sig !== 'vi') {
                throw new Error("LKBridge.DynCall: unsupported signature '" + sig + "'");
            }
            {{{ makeDynCall('vi', 'fnc') }}}(args[0]);
        },

        NewRef: function () {
            var nPtr = LKBridge.RefIndex++;
            LKBridge.RefCount.set(nPtr, 0);
            LKBridge.SetRef(nPtr, null); // Set to null by default
            return nPtr;
        },

        FreeRef: function (ptr) {
            var obj = LKBridge.Data.get(ptr);
            LKBridge.Data.delete(ptr);
            LKBridge.RefCount.delete(ptr);
            LKBridge.Pointers.delete(obj);
        },

        SetRef: function (ptr, obj) {
            LKBridge.Data.set(ptr, obj);

            if (typeof obj === 'object' && obj !== null) {
                LKBridge.Pointers.set(obj, ptr);
            }
        },

        GetOrNewRef: function (obj) {
            var ptr = LKBridge.Pointers.get(obj);
            if (ptr === undefined || typeof obj !== 'object' || obj === null) {
                ptr = LKBridge.NewRef();
                LKBridge.SetRef(ptr, obj);
            }

            return ptr;
        },

        AddRef: function (ptr) {
            LKBridge.RefCount.set(ptr, LKBridge.RefCount.get(ptr) + 1);
            return ptr;
        },

        RemRef: function (ptr) {
            var count = LKBridge.RefCount.get(ptr) - 1;
            LKBridge.RefCount.set(ptr, count);

            if (count < 0) {
                console.error('LKBridge: The ref count of ' + ptr +  '(obj: ' + LKBridge.Data.get(ptr) + ') is negative ( Ptr management is wrong ! )');
            }
            
            if (count <= 0) {
                LKBridge.FreeRef(ptr);
            }

            return ptr;
        }
    },

    NewRef: function () {
        return LKBridge.AddRef(LKBridge.NewRef());
    },
    
    AddRef: function (ptr) {
        LKBridge.AddRef(ptr);
    },

    RemRef: function (ptr) {
        LKBridge.RemRef(ptr);
        return true;
    },
    
    SetRef: function(ptr){
        var value = LKBridge.Stack[0];
        LKBridge.Stack = [];
        LKBridge.SetRef(ptr, value);
    },

    InitLiveKit: function (debug) {
        // When initializing these variables directly, emscripten replace the type by {} (not sure why)
        LKBridge.Debug = debug === 1;
        LKBridge.Data = new Map();
        LKBridge.Pointers = new Map();
        LKBridge.RefCount = new Map();
        LKBridge.VideoFrames = new Map();

        window.lkinternal = LKBridge;
    },

    GetProperty: function (ptr) {
        var key = LKBridge.Stack[0];
        LKBridge.Stack = [];

        var p = LKBridge.Data.get(ptr);
        var obj = p[key];
        
        return LKBridge.AddRef(LKBridge.GetOrNewRef(obj));
    },

    SetProperty: function (ptr) {
        var key = LKBridge.Stack[0];
        var value = LKBridge.Stack[1];
        LKBridge.Stack = [];

        var obj = LKBridge.Data.get(ptr);
        obj[key] = value;
    },

    IsNull: function (ptr) {
        return LKBridge.Data.get(ptr) === null;
    },

    IsUndefined: function (ptr) {
        return LKBridge.Data.get(ptr) === undefined;
    },

    IsString: function (ptr) {
        var obj = LKBridge.Data.get(ptr);
        return typeof obj === 'string' || obj instanceof String;
    },

    IsNumber: function (ptr) {
        var obj = LKBridge.Data.get(ptr);
        return typeof obj === 'number' && !isNaN(obj);
    },

    IsBoolean: function (ptr) {
        var obj = LKBridge.Data.get(ptr);
        return typeof obj === 'boolean';
    },

    IsObject: function (ptr) {
        var obj = LKBridge.Data.get(ptr);
        return typeof obj === 'object' && obj !== null;
    },

    PushNull: function () {
        LKBridge.Stack.push(null);
    },

    PushUndefined: function () {
        LKBridge.Stack.push(undefined);
    },

    PushNumber: function (nb) {
        LKBridge.Stack.push(nb);
    },

    PushBoolean: function (bool) {
        LKBridge.Stack.push(bool === 1);
    },

    PushString: function (str) {
        LKBridge.Stack.push(UTF8ToString(str));
    },

    PushStruct: function (json) {
        LKBridge.Stack.push(JSON.parse(UTF8ToString(json)));
    },

    PushData: function (data, offset, size) {
        var of = data + offset;
        LKBridge.Stack.push(HEAPU8.subarray(of, of + size));
    },

    PushFunction: function (ptr, fnc, labelPtr) {
        var label = UTF8ToString(labelPtr);
        LKBridge.Stack.push(function () {
            if (!LKBridge.Data.has(ptr)) {
                console.warn("Trying to fire an event on a freed object", ptr, fnc, label);
                return;
            } 
            
            try{
                LKBridge.StackCSharp = Array.from(arguments);
                LKBridge.FunctionInstance = this;

                LKBridge.DynCall('vi', fnc, [LKBridge.AddRef(ptr)]);

                LKBridge.FunctionInstance = null;
                LKBridge.StackCSharp = [];
            } catch (e) {
                console.error("An error occured when calling C# callback", fnc, e, label,
                    "StackCSharp:", LKBridge.StackCSharp);
            }
        });
    },

    PushObject: function (ptr) {
        LKBridge.Stack.push(LKBridge.Data.get(ptr));
    },

    CallMethod: function (ptr, str) {
        var stack = LKBridge.Stack;
        LKBridge.Stack = [];
        
        var obj = LKBridge.Data.get(ptr);
        var mName = UTF8ToString(str);
        var fnc = obj[mName];
        var result = undefined;
        
        try{
            result = fnc.apply(obj, stack);
        }catch (e) {
            console.error("Internal issue when calling " + mName + "\n", "Stack: ", stack, e)
        }
        
        return LKBridge.AddRef(LKBridge.GetOrNewRef(result));
    },

    NewInstance: function (ptr, toPtr, clazz) {
        var stack = LKBridge.Stack;
        LKBridge.Stack = [];

        var obj;
        if (ptr === 0) {
            obj = window;
        } else {
            obj = LKBridge.Data.get(ptr);
        }

        var clazz = UTF8ToString(clazz);
        
        var inst = undefined;
        try{
            inst = new (Function.prototype.bind.apply(obj[clazz], stack));
        }catch (e) {
            console.error("Internal issue when trying to instantiate " + clazz + "\n", "Stack: ", stack, e)
        }
        LKBridge.SetRef(toPtr, inst);
    },

    ShiftStack: function () {
        var v = LKBridge.StackCSharp.shift();
        return LKBridge.AddRef(LKBridge.GetOrNewRef(v));
    },

    GetFunctionInstance: function () {
        var v = LKBridge.FunctionInstance;
        return LKBridge.AddRef(LKBridge.GetOrNewRef(v));
    },

    GetString: function (ptr) {
        var value = LKBridge.Data.get(ptr);
        if (value === undefined || value === null)
            return null;

        var bufferSize = lengthBytesUTF8(value) + 1;
        var buffer = _malloc(bufferSize);
        stringToUTF8(value, buffer, bufferSize);
        return buffer;
    },

    GetNumber: function (ptr) {
        return LKBridge.Data.get(ptr);
    },

    GetBoolean: function (ptr) {
        return LKBridge.Data.get(ptr);
    },
    
    CopyData: function(ptr, buff, offset, count) {
        var value = LKBridge.Data.get(ptr);
        var arr = new Uint8Array(value, offset, count);
        HEAPU8.set(arr, buff);
    },

    RetrieveBridgeObject: function(){
        return LKBridge.AddRef(LKBridge.GetOrNewRef(LKBridge));
    },
    
    RetrieveWindowObject: function(){
        return LKBridge.AddRef(LKBridge.GetOrNewRef(window));
    },

    // Video Receive
    // GLctx is undefined when the player runs on WebGPU (Unity 6+), textures must then be fed through the CPU
    IsWebGLContextAvailable: function () {
        return (typeof GLctx !== 'undefined' && GLctx) ? 1 : 0;
    },

    NewTexture: function () {
        var tex = GLctx.createTexture();
        if (!tex){
            console.error("Failed to create a new texture for VideoReceiving")
            return LKBridge.NullPtr;
        }

        var id = GL.getNewId(GL.textures);
        tex.name = id;
        GL.textures[id] = tex;
        return id;
    },

    DestroyTexture: function (id) {
        GLctx.deleteTexture(GL.textures[id]);
    },

    AttachVideo: function (videoPtr, texId) {
        var tex = GL.textures[texId];
        var lastTime = -1;

        var initialVideo = LKBridge.PrepareVideo(videoPtr);
        var updateVideo = function () {
            var video = LKBridge.Data.get(videoPtr);
            if (video === undefined) {
		        initialVideo.remove();
                return;
	        }
            
            var time = video.currentTime;
            if (!video.paused && video.srcObject !== null && time !== lastTime) {
                lastTime = time;
                GLctx.bindTexture(GLctx.TEXTURE_2D, tex);
                
                // Flip Y
                GLctx.pixelStorei(GLctx.UNPACK_FLIP_Y_WEBGL, true);
                GLctx.texImage2D(GLctx.TEXTURE_2D, 0, GLctx.RGBA, GLctx.RGBA, GLctx.UNSIGNED_BYTE, video);
                GLctx.pixelStorei(GLctx.UNPACK_FLIP_Y_WEBGL, false);

                GLctx.texParameteri(GLctx.TEXTURE_2D, GLctx.TEXTURE_MAG_FILTER, GLctx.LINEAR);
                GLctx.texParameteri(GLctx.TEXTURE_2D, GLctx.TEXTURE_MIN_FILTER, GLctx.LINEAR);
                GLctx.texParameteri(GLctx.TEXTURE_2D, GLctx.TEXTURE_WRAP_S, GLctx.CLAMP_TO_EDGE);
                GLctx.texParameteri(GLctx.TEXTURE_2D, GLctx.TEXTURE_WRAP_T, GLctx.CLAMP_TO_EDGE);
            }
            
            requestAnimationFrame(updateVideo);
        };
        
        requestAnimationFrame(updateVideo);
    },

    // Video Receive (WebGPU): Unity's Texture2D is filled from the C# side, polled every frame.
    // Frames are copied on the GPU (copyExternalImageToTexture) when Unity's GPUTexture is reachable,
    // otherwise they are read back through a 2D canvas and uploaded by C# (LoadRawTextureData).
    AttachVideoCPU: function (videoPtr) {
        var video = LKBridge.PrepareVideo(videoPtr);
        var id = LKBridge.NextVideoFrameId++;

        LKBridge.VideoFrames.set(id, {
            videoPtr: videoPtr,
            element: video,
            canvas: null,
            ctx: null,
            texture: null, // GPUTexture of the Unity Texture2D
            device: null,
            lastTime: -1,
            width: 0,
            height: 0,
        });
        return id;
    },

    // Binds the native pointer of a Unity texture, returns 1 if frames can be copied on the GPU
    BindVideoFrameTexture: function (id, nativePtr) {
        var frame = LKBridge.VideoFrames.get(id);
        if (frame === undefined)
            return 0;

        frame.texture = null;
        frame.device = null;

        // wgpu is Unity's WebGPU object table (handle -> GPU object)
        if (typeof wgpu === 'undefined' || typeof GPUTexture === 'undefined')
            return 0;

        var texture = wgpu[nativePtr];
        if (!(texture instanceof GPUTexture))
            return 0;

        var requiredUsage = GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
        if ((texture.usage & requiredUsage) !== requiredUsage)
            return 0;

        var device = (Module["WebGPU"] && Module["WebGPU"].device) || texture.parentObject;
        if (!(device instanceof GPUDevice))
            return 0;

        frame.texture = texture;
        frame.device = device;
        return 1;
    },

    // Returns 1 when a new frame is available ( size: GetVideoFrameWidth/GetVideoFrameHeight )
    UpdateVideoFrame: function (id) {
        var frame = LKBridge.VideoFrames.get(id);
        if (frame === undefined)
            return 0;

        var video = LKBridge.Data.get(frame.videoPtr);
        if (video === undefined) {
            frame.element.remove();
            LKBridge.VideoFrames.delete(id);
            return 0;
        }

        var time = video.currentTime;
        var width = video.videoWidth;
        var height = video.videoHeight;
        if (video.paused || video.srcObject === null || time === frame.lastTime || width === 0 || height === 0)
            return 0;

        frame.lastTime = time;
        frame.width = width;
        frame.height = height;
        return 1;
    },

    // Copies the current frame into the bound GPUTexture, returns 0 on failure ( fallback to CopyVideoFrame )
    UploadVideoFrameGPU: function (id) {
        var frame = LKBridge.VideoFrames.get(id);
        if (frame === undefined || frame.texture === null)
            return 0;

        if (frame.texture.width !== frame.width || frame.texture.height !== frame.height)
            return 0;

        try {
            frame.device.queue.copyExternalImageToTexture(
                { source: frame.element, flipY: true },
                { texture: frame.texture },
                [frame.width, frame.height]);
        } catch (e) {
            console.warn("LKBridge: GPU video upload failed, falling back to CPU copy", e);
            frame.texture = null;
            return 0;
        }
        return 1;
    },

    GetVideoFrameWidth: function (id) {
        var frame = LKBridge.VideoFrames.get(id);
        return frame === undefined ? 0 : frame.width;
    },

    GetVideoFrameHeight: function (id) {
        var frame = LKBridge.VideoFrames.get(id);
        return frame === undefined ? 0 : frame.height;
    },

    CopyVideoFrame: function (id, buffer, size) {
        var frame = LKBridge.VideoFrames.get(id);
        if (frame === undefined || frame.width === 0 || frame.height === 0)
            return;

        if (frame.canvas === null) {
            frame.canvas = document.createElement("canvas");
            frame.ctx = frame.canvas.getContext("2d", { willReadFrequently: true });
        }

        var width = frame.width;
        var height = frame.height;
        if (frame.canvas.width !== width || frame.canvas.height !== height) {
            frame.canvas.width = width;
            frame.canvas.height = height;
        }

        // Flip Y
        frame.ctx.setTransform(1, 0, 0, -1, 0, height);
        frame.ctx.drawImage(frame.element, 0, 0, width, height);

        var data = frame.ctx.getImageData(0, 0, width, height).data;
        HEAPU8.set(data.subarray(0, size), buffer);
    },

    DestroyVideoCPU: function (id) {
        var frame = LKBridge.VideoFrames.get(id);
        if (frame === undefined)
            return;

        frame.element.remove();
        LKBridge.VideoFrames.delete(id);
    },
};

autoAddDeps(NativeLib, '$LKBridge');
mergeInto(LibraryManager.library, NativeLib);
