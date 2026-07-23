// Browser-native video decode. Two paths, chosen by what the browser offers:
//
//   * WebCodecs (webcodecs.js) -- the preferred one. We demux the container
//     ourselves and feed samples to the platform's VideoDecoder, which runs at
//     hardware speed and reports each frame's exact timestamp.
//
//   * A hidden <video> played and read back through a 2D canvas -- the fallback,
//     for browsers with no WebCodecs (Firefox Android). Playing rather than
//     seeking is the whole performance story here: seeking each frame measured
//     ~350ms per frame, 99% of decode time, because every seek makes the browser
//     find a keyframe and decode forward again. Even so it is bounded by the
//     display refresh rate, and it has to guess the frame rate, which is the
//     temporal jitter described in WEB-PORT-HANDOFF.md §12.
//
// The pixel buffer runs to tens of megabytes, which must not cross into .NET as
// JSON. decodeVideo() therefore parks the buffer here and returns only metadata;
// the caller then collects the bytes with takePixels(), which hands over a
// stream reference instead.

// The query strings matter: decode.js is imported with one, but its own imports
// are not covered by it, so a stale volume.js or webcodecs.js is served happily
// while decode.js is fresh. That shows up as "volume.sampleSlice is not a
// function" -- new caller, old module. Bump these with DecodeModule.
// Imported dynamically, carrying this module's own version forward.
//
// Hand-stamped versions were the problem: decode.js could be fresh while
// volume.js was cached (and vice versa), and worse, the JS could be new while
// the .NET assemblies were stale -- GitHub Pages caches everything for 600s and
// Blazor's assembly filenames are not content-hashed. The version now comes from
// the build (see BrowserVideoDecoder.DecodeModule) and is threaded through here,
// so every piece is from the same build or none of it is.
const VERSION = new URL(import.meta.url).searchParams.get('v') ?? '';
const suffix = VERSION ? `?v=${VERSION}` : '';

const webcodecs = await import(`./webcodecs.js${suffix}`);
const volume = await import(`./volume.js${suffix}`);

/// Whether a browser without WebCodecs may fall back to the <video> element.
///
/// On for normal use: WebCodecs is missing on Firefox Android and on older
/// Safari, and the <video> path still works there -- slower, and with the
/// temporal jitter described in WEB-PORT-HANDOFF.md §12, but working.
///
/// Turn it off to compare browsers: with a fallback available, a clip that
/// decodes "fine" tells you nothing about which path produced it.
const ALLOW_VIDEO_FALLBACK = true;

const pending = new Map();
let nextId = 1;

/// Why the preferred path was abandoned, if it was. Reported with the decode:
/// a fallback that only logs is invisible on a phone, and "the video element is
/// showing" is otherwise the sole clue that WebCodecs did not run.
let fallbackReason = '';

/// Fraction of the display's refresh rate to aim at while capturing.
///
/// requestVideoFrameCallback fires at most once per screen refresh, so the
/// capture rate is hard-capped by the monitor: playing a 30fps clip at 8x on a
/// 60Hz display asks for 240 frames/second and delivers 60, losing five frames
/// in six. Every frame lost then costs a ~350ms seek to recover, which is far
/// more than the playback time saved. So the clip is played only as fast as the
/// screen can actually present it, with headroom for jitter.
const REFRESH_HEADROOM = 0.8;
const MAX_PLAYBACK_RATE = 8;

/// How many times to replay looking for frames the previous pass dropped.
/// Bounded so a clip the browser simply will not present cleanly still finishes
/// via seeking rather than looping.
const MAX_PLAYBACK_PASSES = 3;

/// The browser will not report a frame count or an exact rate, so the clip is
/// treated as this. See §12 of WEB-PORT-HANDOFF.md: this assumption is also the
/// cause of the known temporal jitter, and WebCodecs removes the need for it.
const TARGET_FPS = 30;

/// How many texels survive on each axis, given the budget.
///
/// The clip is CROPPED to fit, never scaled: scaling throws away detail
/// everywhere, while cropping keeps every surviving texel at its native
/// resolution. The frame rate is likewise never thinned -- slices stay one real
/// frame apart.
///
/// Every axis is capped at a common threshold T, so size = min(original, T).
/// That single rule gives the whole policy: as T falls it bites into the largest
/// axis first; an axis it has cropped can never end up smaller than one it has
/// not (cropped axes all sit at T, uncropped ones are below it); and a very
/// small budget converges on a cube, while a generous one leaves a cuboid. T is
/// also bounded by the 3D texture limit.
///
/// Note this fixes only the SIZE of the surviving window. Where that window sits
/// on each axis is the user's to choose -- see the offsets passed to decode.
function sizeFor(sourceWidth, sourceHeight, sourceFrames, maxDimension, maxBytes) {
    let lo = 1, hi = maxDimension, threshold = 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const texels = Math.min(sourceWidth, mid) * Math.min(sourceHeight, mid) * Math.min(sourceFrames, mid);
        if (texels * 4 <= maxBytes) {
            threshold = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return {
        width: Math.min(sourceWidth, threshold),
        height: Math.min(sourceHeight, threshold),
        frames: Math.min(sourceFrames, threshold),
    };
}

/// Loads only the metadata and reports what would survive the budget, without
/// decoding a single frame. The crop UI needs the sizes up front to know how far
/// each axis can travel.
export async function planVideo(source, maxDimension, maxBytes) {
    // Where WebCodecs exists the container gives an exact frame count, so the
    // crop sliders describe the real clip rather than a 30fps estimate of it.
    if (webcodecs.supported()) {
        try {
            const demuxed = await webcodecs.demux(source);
            const size = sizeFor(demuxed.width, demuxed.height, demuxed.frames, maxDimension, maxBytes);

            return {
                sourceWidth: demuxed.width,
                sourceHeight: demuxed.height,
                sourceFrames: demuxed.frames,
                width: size.width, height: size.height, frames: size.frames,
            };
        } catch (error) {
            if (!ALLOW_VIDEO_FALLBACK)
                throw new Error(`WebCodecs plan failed (fallback disabled): ${error.message}`);

            // Anything the demuxer cannot read -- a WebM, a codec it does not
            // know -- falls through to the <video> element, which handles
            // whatever the browser can play.
            fallbackReason = `mp4box could not read the file: ${error.message}`;
            console.log(`${fallbackReason} -- planning with <video>`);
        }
    } else if (!ALLOW_VIDEO_FALLBACK) {
        throw new Error('this browser has no WebCodecs (fallback disabled)');
    }

    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.src = source;

    try {
        await once(video, 'loadedmetadata', 30000);

        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        const duration = video.duration;

        if (!sourceWidth || !sourceHeight)
            throw new Error('the video reported no dimensions');
        if (!isFinite(duration) || duration <= 0)
            throw new Error('the video reported no usable duration');

        const sourceFrames = Math.max(1, Math.round(duration * TARGET_FPS));
        const size = sizeFor(sourceWidth, sourceHeight, sourceFrames, maxDimension, maxBytes);

        return {
            sourceWidth, sourceHeight, sourceFrames,
            width: size.width, height: size.height, frames: size.frames,
        };
    } finally {
        video.removeAttribute('src');
        video.load();
    }
}

/// Measured rather than assumed -- 60Hz, 120Hz and 144Hz displays all give
/// different safe playback rates, and guessing low wastes real time.
let refreshHz = 0;
function measureRefreshHz() {
    if (refreshHz)
        return Promise.resolve(refreshHz);

    return new Promise((resolve) => {
        const samples = [];
        let last = 0;

        const tick = (now) => {
            if (last)
                samples.push(now - last);
            last = now;

            if (samples.length < 12) {
                requestAnimationFrame(tick);
                return;
            }

            // Median, so one hitched frame does not skew the estimate.
            samples.sort((a, b) => a - b);
            const median = samples[samples.length >> 1];
            refreshHz = median > 0 ? Math.round(1000 / median) : 60;
            resolve(refreshHz);
        };

        requestAnimationFrame(tick);
    });
}

/// Limits read from a real WebGL2 context, since neither can be assumed:
/// the spec only guarantees MAX_3D_TEXTURE_SIZE of 256, and exceeding either
/// fails the allocation outright.
///
/// maxTexture decides which KNI GraphicsProfile is available -- KNI's own
/// FL10_0 test is MAX_TEXTURE_SIZE >= 8192 -- and that in turn sets the
/// Texture3D ceiling (2048 on FL10_0 versus 256 on HiDef).
export function glLimits() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl)
        return { maxTexture3D: 0, maxTexture: 0 };

    const MAX_3D_TEXTURE_SIZE = 0x8073;
    return {
        maxTexture3D: gl.getParameter(MAX_3D_TEXTURE_SIZE) | 0,
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0,
        // WebCodecs is gated on a secure context, so over plain http on a LAN
        // address VideoDecoder is undefined no matter which browser it is --
        // which looks exactly like the browser not supporting it. localhost is
        // exempt, which is why the same browser works on a desktop.
        secureContext: !!window.isSecureContext,
        hasVideoDecoder: typeof VideoDecoder !== 'undefined',
    };
}

/// Can WebGL get pixels out of a <video> on this browser, when canvas 2D cannot?
///
/// Firefox Android returns pure black from drawImage + getImageData even for a
/// visible, natively sized, actively playing video -- so the 2D readback path is
/// simply unavailable there. WebGL texture upload is a different path entirely
/// (typically a direct bind of the decoder's surface, which is how video-in-3D
/// works on phones at all), so it may well succeed where the other fails.
///
/// This is deliberately a cheap probe rather than the real thing: uploading
/// straight into the volume would mean patching KNI's Texture3D for a video
/// source and reworking the decoder seam, and there is no point paying for that
/// before knowing whether the browser will cooperate.
export async function probeVideoTexture(source) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.style.cssText = 'position:fixed; left:0; top:0; width:64px; height:36px; opacity:0.02; pointer-events:none;';
    document.body.appendChild(video);
    video.src = source;

    try {
        await once(video, 'loadedmetadata', 30000);

        // Part-way in, so a black first frame cannot be mistaken for failure.
        video.currentTime = Math.min(video.duration * 0.5, video.duration);
        await once(video, 'seeked', 30000);

        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2');
        if (!gl)
            return 'gl probe: no webgl2';

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // The call under test: the video element as a pixel source.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

        const uploadError = gl.getError();
        if (uploadError !== gl.NO_ERROR)
            return `gl probe: texImage2D failed, GL error 0x${uploadError.toString(16)}`;

        // Read it back through a framebuffer, the only way to see what landed.
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            return 'gl probe: framebuffer incomplete (cannot read the texture back)';

        const w = Math.min(64, video.videoWidth);
        const h = Math.min(64, video.videoHeight);
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Brightness alone is not evidence of a picture: Firefox Android returns
        // a flat #330033 placeholder for a video it will not share, and
        // "brightest 51" passed a > 8 threshold while carrying no image at all.
        // Variation is the test -- a real frame is never one colour.
        const flat = measureVariation(pixels);
        const brightest = flat.max;

        // The 2D result is encouraging but not the call we would actually make.
        // The volume needs a video frame written into one SLICE of a 3D texture,
        // and "2D works" does not imply "3D slice works" -- WebGL2 allows a
        // TexImageSource for texSubImage3D, but allowing is not implementing.
        const slice = probeVideoSlice(gl, video);

        return `gl probe: texImage2D(video) ${flat.describe} `
             + `(${flat.isPicture ? 'ok' : 'NO PICTURE'})\n`
             + `gl probe: ${slice}\n`
             + `gl probe: ${probeVideoSliceViaCopy(gl, video)}`;
    } catch (error) {
        return `gl probe: threw ${error}`;
    } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
    }
}

/// The call GPU upload would actually depend on: a video frame into one slice
/// of a TEXTURE_3D, read back through a layered framebuffer attachment.
/// Distinguishes an image from a solid fill. A frame varies; a placeholder does
/// not, however bright it is.
function measureVariation(pixels) {
    let min = 255, max = 0;
    const seen = new Set();

    for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const value = pixels[i + c];
            min = Math.min(min, value);
            max = Math.max(max, value);
        }
        if (seen.size < 64)
            seen.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    }

    return {
        min, max,
        colours: seen.size,
        isPicture: seen.size > 4 && max - min > 24,
        describe: `range ${min}..${max}, ${seen.size} distinct colours`,
    };
}

function probeVideoSlice(gl, video) {
    const size = 64;
    const depth = 4;
    const layer = 1;

    try {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, texture);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, size, size, depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        if (gl.getError() !== gl.NO_ERROR)
            return 'texSubImage3D(video): could not allocate a 3D texture';

        // Only as much of the frame as the slice holds; a source rectangle is
        // not expressible here, which is itself something the real
        // implementation would have to work around.
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, layer, size, size, 1,
                         gl.RGBA, gl.UNSIGNED_BYTE, video);

        const uploadError = gl.getError();
        if (uploadError !== gl.NO_ERROR)
            return `texSubImage3D(video): REJECTED, GL error 0x${uploadError.toString(16)}`;

        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            return 'texSubImage3D(video): uploaded, but the slice could not be read back';

        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        const result = measureVariation(pixels);
        return `texSubImage3D(video) ${result.describe} `
             + `(${result.isPicture ? 'WORKS' : 'NO PICTURE'})`;
    } catch (error) {
        return `texSubImage3D(video): threw ${error}`;
    }
}

/// The two-step route, for browsers that refuse a video straight into a 3D
/// texture: upload the frame to a 2D texture (which Firefox Android does allow),
/// then copy that into the slice with copyTexSubImage3D. Everything stays on the
/// GPU -- no canvas, no readback.
function probeVideoSliceViaCopy(gl, video) {
    const size = 64;
    const depth = 4;
    const layer = 1;

    try {
        // Step 1: the frame into a 2D texture. Already known to work.
        const flat = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, flat);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

        if (gl.getError() !== gl.NO_ERROR)
            return 'copyTexSubImage3D: the 2D upload failed';

        const volume = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, volume);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, size, size, depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        // Step 2: copy out of a framebuffer backed by the 2D texture, into one
        // slice of the 3D texture.
        const readFrom = gl.createFramebuffer();
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFrom);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, flat, 0);

        if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            return 'copyTexSubImage3D: the video texture cannot back a framebuffer';

        gl.bindTexture(gl.TEXTURE_3D, volume);
        gl.copyTexSubImage3D(gl.TEXTURE_3D, 0, 0, 0, layer, 0, 0, size, size);

        const copyError = gl.getError();
        if (copyError !== gl.NO_ERROR)
            return `copyTexSubImage3D: REJECTED, GL error 0x${copyError.toString(16)}`;

        // Read the slice back to prove something actually landed in it.
        const check = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, check);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volume, 0, layer);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            return 'copyTexSubImage3D: copied, but the slice could not be read back';

        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        const result = measureVariation(pixels);
        return `copyTexSubImage3D(2D->slice) ${result.describe} `
             + `(${result.isPicture ? 'WORKS -- GPU upload viable' : 'NO PICTURE -- a flat fill, not a frame'})`;
    } catch (error) {
        return `copyTexSubImage3D: threw ${error}`;
    }
}

function once(target, event, timeoutMs) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            target.removeEventListener(event, onEvent);
            target.removeEventListener('error', onError);
            clearTimeout(timer);
        };
        const onEvent = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error(`<video> failed during '${event}'`)); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for '${event}'`)); }, timeoutMs);

        target.addEventListener(event, onEvent, { once: true });
        target.addEventListener('error', onError, { once: true });
    });
}

/// Copies the current video frame into slice `index` of the volume.
function storeFrame(video, context, texels, plan, index) {
    if (plan.toTexture) {
        volume.uploadSlice(video, index, plan.cropX, plan.cropY, plan.width, plan.height);
        return;
    }

    // The 9-argument form: copy the centre crop 1:1, no resampling.
    context.drawImage(video, plan.cropX, plan.cropY, plan.width, plan.height,
                      0, 0, plan.width, plan.height);
    texels.set(context.getImageData(0, 0, plan.width, plan.height).data,
               index * plan.bytesPerFrame);
}

/// The slow path, kept for browsers without requestVideoFrameCallback and for
/// filling in frames that playback dropped.
async function grabBySeeking(video, context, texels, plan, index) {
    video.currentTime = Math.min(plan.duration, (plan.firstFrame + index + 0.5) / plan.fps);
    await once(video, 'seeked', 30000);
    storeFrame(video, context, texels, plan, index);
}

/// Plays the clip and captures frames as they are presented. Returns how many
/// slices were filled.
///
/// Faster than seeking by orders of magnitude, because the decoder runs forward
/// through the stream exactly once instead of restarting from a keyframe for
/// every frame. Playback is sped up as far as it will go; the browser drops
/// frames rather than falling behind, and anything dropped is picked up
/// afterwards by seeking.
function capturePlaying(video, context, texels, plan, filled, playbackRate, startIndex) {
    return new Promise((resolve) => {
        const windowEnd = (plan.firstFrame + plan.frames) / plan.fps;
        let captured = 0;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            video.pause();
            video.playbackRate = 1;
            resolve(captured);
        };

        const onFrame = (now, metadata) => {
            const done = video.ended || metadata.mediaTime > windowEnd;

            // Re-registered before the pixel work, not after. rVFC delivers only
            // the next frame presented *after* registration, so doing the copy
            // first means any frame presented during it is missed outright --
            // and each miss costs a ~350ms seek later.
            if (!done)
                video.requestVideoFrameCallback(onFrame);

            // mediaTime is this frame's own presentation timestamp, so a dropped
            // frame shifts nothing: each frame lands in its true slice.
            const index = Math.round(metadata.mediaTime * plan.fps) - plan.firstFrame;

            if (index >= 0 && index < plan.frames && !filled[index]) {
                storeFrame(video, context, texels, plan, index);
                filled[index] = 1;
                captured++;
            }

            if (done)
                finish();
        };

        video.addEventListener('ended', finish, { once: true });
        video.requestVideoFrameCallback(onFrame);

        video.currentTime = Math.max(0, (plan.firstFrame + startIndex) / plan.fps);
        video.playbackRate = playbackRate;
        // Muted playback needs no user gesture. If it is refused anyway, the
        // seeking fallback still produces a correct volume.
        video.play().catch(finish);
    });
}

/// Whether this browser will give up video pixels at all.
///
/// Firefox Android will not, by any route: no WebCodecs, black from a canvas,
/// and a flat #330033 placeholder from WebGL. Verified with a standalone page
/// carrying none of this app's machinery (wwwroot/videotest.html), across
/// crossOrigin, visibility and play-versus-seek. Asking up front means saying so
/// in a second instead of decoding for half a minute and drawing a solid colour.
export async function canDecodeVideo(source) {
    if (webcodecs.supported())
        return true;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.cssText = 'position:fixed; left:0; top:0; width:64px; height:36px; opacity:0.01; pointer-events:none;';
    document.body.appendChild(video);
    video.src = source;

    try {
        await once(video, 'loadedmetadata', 20000);
        video.currentTime = video.duration / 2;
        await once(video, 'seeked', 20000);

        const width = Math.min(64, video.videoWidth);
        const height = Math.min(64, video.videoHeight);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, width, height);

        return measureVariation(context.getImageData(0, 0, width, height).data).isPicture;
    } catch (error) {
        return false;
    } finally {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
    }
}

/// Decodes into an existing Texture3D on the GPU, returning only metadata.
///
/// For browsers that will not surrender video pixels to a canvas -- Firefox
/// Android returns pure black -- and generally cheaper than the byte path, which
/// moves the whole volume through the WASM heap on its way back to the GPU.
export async function decodeVideoToTexture(source, maxDimension, maxBytes,
                                           offsetX, offsetY, offsetFrame, textureUid) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.style.cssText =
        'position:fixed; left:0; top:0; width:128px; height:72px; opacity:0.01;'
        + ' pointer-events:none; z-index:0;';
    document.body.appendChild(video);
    video.src = source;

    try {
        return await decodeInto(video, maxDimension, maxBytes, offsetX, offsetY, offsetFrame, textureUid);
    } finally {
        // Harmless if decodeInto already closed it -- end() is idempotent and
        // reports 0 the second time. This is for the throwing path.
        volume.end();

        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
    }
}

// ---------------------------------------------------------------------------
// Frame atlases -- the fallback for browsers that decode no video at all.
//
// Firefox Android refuses video pixels by every route there is (§13, closed
// upstream as Mozilla bug 1884282). That bug is about *video* sources; ordinary
// images upload and read back normally. So build-content-atlas.sh decodes the
// clip ahead of time into sheets of tiled frames, and this reads them back with
// the same GPU machinery the video path uses -- one upload per sheet instead of
// one per frame, then a copyTexSubImage3D per tile.
// ---------------------------------------------------------------------------

/// Fetched once per URL: a manifest is a couple of kilobytes, immutable for a
/// build, and wanted by both the plan and the decode that follows it.
const manifests = new Map();

async function loadManifest(manifestUrl) {
    let manifest = manifests.get(manifestUrl);

    if (!manifest) {
        const response = await fetch(manifestUrl);
        if (!response.ok)
            throw new Error(`${manifestUrl}: HTTP ${response.status}`);

        manifest = await response.json();
        manifests.set(manifestUrl, manifest);
    }

    return manifest;
}

/// Sheet paths are relative to the manifest, so a clip's atlas stays one
/// self-contained directory that can be moved or renamed as a unit.
function atlasBase(manifestUrl) {
    return manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
}

/// Whether an atlas has been built for this clip. Used to decide whether a
/// browser with no video decode has anything to fall back TO, so a 404 here is
/// an answer rather than a failure.
export async function hasAtlas(manifestUrl) {
    try {
        await loadManifest(manifestUrl);
        return true;
    } catch {
        return false;
    }
}

/// What the atlas holds and what each variant costs to download. Fetches no
/// sheets: this is what the quality choice is offered from, so it has to be
/// cheap enough to run before the user has chosen anything.
export async function atlasInfo(manifestUrl) {
    const manifest = await loadManifest(manifestUrl);

    return {
        sourceWidth: manifest.sourceWidth,
        sourceHeight: manifest.sourceHeight,
        sourceFrames: manifest.sourceFrames,
        framesPerSecond: manifest.framesPerSecond,
        variants: Object.entries(manifest.variants).map(([name, variant]) => ({
            name,
            bytes: variant.bytes,
            lossless: !!variant.lossless,
        })),
    };
}

/// The atlas equivalent of planVideo: what the budget would keep, read straight
/// off the manifest with nothing fetched or decoded.
export async function planAtlas(manifestUrl, maxDimension, maxBytes) {
    const manifest = await loadManifest(manifestUrl);
    const size = sizeFor(manifest.sourceWidth, manifest.sourceHeight, manifest.sourceFrames,
                         maxDimension, maxBytes);

    return {
        sourceWidth: manifest.sourceWidth,
        sourceHeight: manifest.sourceHeight,
        sourceFrames: manifest.sourceFrames,
        width: size.width, height: size.height, frames: size.frames,
    };
}

/// How often download progress is reported to .NET.
///
/// Each report re-renders the Blazor component, and a bar redrawn per network
/// chunk would cost more than the download it is describing.
const PROGRESS_INTERVAL_MS = 150;

function progressReporter(progress, total) {
    let lastAt = 0;

    return (received, phase, force) => {
        if (!progress)
            return;

        const now = performance.now();
        if (!force && now - lastAt < PROGRESS_INTERVAL_MS)
            return;

        lastAt = now;

        // Deliberately not awaited: a round trip into .NET per chunk would
        // serialise the download behind the UI thread. A dropped report just
        // means the bar misses one step.
        progress.invokeMethodAsync('ReportAtlasProgress', received, total, phase)
                .catch(() => {});
    };
}

/// Fetches one sheet, reporting bytes as they arrive.
///
/// Streamed rather than a plain .blob() so the progress bar reflects the
/// download rather than jumping from 0 to 100 per sheet -- on the lossless
/// variant a sheet is ~8 MiB, which is a long time to show nothing.
async function fetchSheet(url, onChunk) {
    const response = await fetch(url);
    if (!response.ok)
        throw new Error(`${url}: HTTP ${response.status}`);

    // Every browser this path targets has a streaming body, but a cached or
    // proxied response can lack one, and a missing bar beats a failed load.
    if (!response.body)
        return await response.blob();

    const reader = response.body.getReader();
    const chunks = [];

    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;

        chunks.push(value);
        onChunk(value.byteLength);
    }

    return new Blob(chunks);
}

/// Fills an existing Texture3D from a pre-decoded frame atlas.
///
/// `variantName` picks the encoding -- 'jpeg' for the quick default, 'webp' for
/// the lossless upgrade. `progress` is an optional .NET object reference that
/// receives ReportAtlasProgress(received, total, phase).
export async function decodeAtlasToTexture(manifestUrl, variantName, maxDimension, maxBytes,
                                           offsetX, offsetY, offsetFrame, textureUid, progress) {
    const started = performance.now();
    const manifest = await loadManifest(manifestUrl);
    const variant = manifest.variants[variantName];

    if (!variant)
        throw new Error(`the atlas has no '${variantName}' variant`);

    const { sourceWidth, sourceHeight, sourceFrames,
            tileCols, tileRows, sheetWidth, sheetHeight } = manifest;

    const size = sizeFor(sourceWidth, sourceHeight, sourceFrames, maxDimension, maxBytes);
    const { width, height, frames } = size;

    // Same rule as every other path: the budget fixes how much of each axis
    // survives, the user chooses which part, and a stale offset is clamped
    // rather than trusted.
    const place = (offset, sourceSize, keptSize) =>
        Math.max(0, Math.min(sourceSize - keptSize, Math.round(offset ?? (sourceSize - keptSize) / 2)));

    const cropX = place(offsetX, sourceWidth, width);
    const cropY = place(offsetY, sourceHeight, height);
    const firstFrame = place(offsetFrame, sourceFrames, frames);

    const perSheet = tileCols * tileRows;
    const firstSheet = Math.floor(firstFrame / perSheet);
    const lastSheet = Math.floor((firstFrame + frames - 1) / perSheet);

    // Only the sheets the chosen crop actually reads, which is also what the
    // progress bar counts towards. A 256-frame window of a 351-frame clip skips
    // two sheets outright, and on the lossless variant a sheet is ~8 MiB of
    // someone's mobile data.
    let total = 0;
    for (let s = firstSheet; s <= lastSheet; s++)
        total += variant.sheets[s].bytes;

    const report = progressReporter(progress, total);
    const base = atlasBase(manifestUrl);

    // Before begin(), since it binds its own scratch objects: works out how this
    // device wants an ImageBitmap turned over. Cheap, cached, and the difference
    // between frames in order and frames scrambled.
    await volume.probeSheetOrientation();

    // The scratch texture holds a whole sheet, so the flip maths inside volume.js
    // is relative to the sheet rather than to one frame.
    volume.begin(textureUid, sheetWidth, sheetHeight);

    let received = 0;
    let sample = '';
    let uploaded = 0;

    try {
        for (let s = firstSheet; s <= lastSheet; s++) {
            const blob = await fetchSheet(base + variant.sheets[s].file, (bytes) => {
                received += bytes;
                report(received, 'downloading', false);
            });

            report(received, 'decoding', true);

            // volume.decodeImage, not createImageBitmap -- an <img>, whose
            // orientation every browser agrees on, and the exact function
            // probeSheetOrientation measures with. There is now no orientation
            // request to keep in step with the probe, which is what went wrong
            // here: the option said 'flipY' while the probe measured 'none',
            // so the probe's answer was right about a road the sheets did not
            // travel. One source of truth instead of two.
            const decoded = await volume.decodeImage(blob);

            try {
                volume.uploadSheet(decoded.image);
            } finally {
                // The sheet lives in the scratch texture from here on and the
                // tile copies never touch the image again. Releasing now keeps
                // only one decoded sheet (~57 MiB at 3840x3888) alive at a time,
                // which on a phone is the difference between working and not.
                decoded.release();
            }

            const from = Math.max(firstFrame, s * perSheet);
            const to = Math.min(firstFrame + frames, (s + 1) * perSheet);

            for (let frame = from; frame < to; frame++) {
                const inSheet = frame - s * perSheet;
                const col = inSheet % tileCols;
                const row = Math.floor(inSheet / tileCols);

                volume.copyTile(
                    frame - firstFrame,
                    col * sourceWidth + cropX,
                    row * sourceHeight + cropY,
                    width, height);
            }

            report(received, 'uploading', true);
        }

        // Sampled before end() tears the state down, for the same reason the
        // video path does it: "the copy wrote rubbish" and "the copy was fine
        // and something downstream is wrong" look identical on screen.
        sample = volume.sampleSlice(Math.floor(frames / 2), width, height);
    } finally {
        uploaded = volume.end();
    }

    if (uploaded === 0)
        throw new Error('no frames reached the volume texture');

    const totalMs = performance.now() - started;

    const diagnostics =
        `decoder rev6: pre-decoded ${variantName} atlas` +
        `${variant.lossless ? ' (lossless)' : ' (lossy)'}\n` +
        `${width}x${height}x${frames} of ${sourceWidth}x${sourceHeight}x${sourceFrames}\n` +
        `loaded in ${(totalMs / 1000).toFixed(1)}s, ${uploaded}/${frames} slices uploaded\n` +
        `sheets ${firstSheet + 1}-${lastSheet + 1} of ${variant.sheets.length}, ` +
        `${(received / (1024 * 1024)).toFixed(1)} MiB fetched\n` +
        // Reported because it decides whether the frames are in order at all,
        // and because a wrong answer here shows up as scrambled time rather
        // than as anything that looks like an orientation problem.
        `${volume.orientationReport()}\n` +
        `${sample}`;

    console.log(diagnostics);

    return {
        width, height, frames,
        sourceFrames,
        framesPerSecond: manifest.framesPerSecond,
        diagnostics,
    };
}

/// Decodes `source` (a URL or an object URL) into RGBA texels laid out x
/// fastest, then y, then z -- exactly what Texture3D.SetData wants.
export async function decodeVideo(source, maxDimension, maxBytes, offsetX, offsetY, offsetFrame) {
    if (webcodecs.supported()) {
        try {
            return await decodeWithWebCodecs(source, maxDimension, maxBytes, offsetX, offsetY, offsetFrame);
        } catch (error) {
            if (!ALLOW_VIDEO_FALLBACK)
                throw new Error(`WebCodecs decode failed (fallback disabled): ${error.message}`);

            // The <video> element understands more formats than our demuxer
            // does, so a failure here is a reason to fall back rather than to
            // give up.
            fallbackReason = `WebCodecs decode failed: ${error.message}`;
            console.log(`${fallbackReason} -- falling back to <video>`);
        }
    } else if (!ALLOW_VIDEO_FALLBACK) {
        throw new Error('this browser has no WebCodecs (fallback disabled)');
    }

    return await decodeWithVideoElement(source, maxDimension, maxBytes, offsetX, offsetY, offsetFrame);
}

async function decodeWithWebCodecs(source, maxDimension, maxBytes, offsetX, offsetY, offsetFrame) {
    const started = performance.now();
    const demuxed = await webcodecs.demux(source);

    const size = sizeFor(demuxed.width, demuxed.height, demuxed.frames, maxDimension, maxBytes);
    const { width, height, frames } = size;

    const place = (offset, sourceSize, keptSize) =>
        Math.max(0, Math.min(sourceSize - keptSize, Math.round(offset ?? (sourceSize - keptSize) / 2)));

    const plan = {
        width, height, frames,
        cropX: place(offsetX, demuxed.width, width),
        cropY: place(offsetY, demuxed.height, height),
        firstFrame: place(offsetFrame, demuxed.frames, frames),
        bytesPerFrame: width * height * 4,
    };

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');

    const texels = new Uint8Array(plan.bytesPerFrame * frames);

    // A VideoFrame is a CanvasImageSource, so the same centre crop applies: the
    // 9-argument drawImage, 1:1, no resampling.
    const storeFrame = (frame, index) => {
        context.drawImage(frame, plan.cropX, plan.cropY, width, height, 0, 0, width, height);
        texels.set(context.getImageData(0, 0, width, height).data, index * plan.bytesPerFrame);
    };

    const stored = await webcodecs.decodeFrames(demuxed, plan, texels, storeFrame);
    const totalMs = performance.now() - started;

    if (stored === 0)
        throw new Error('WebCodecs produced no frames');

    const diagnostics =
        `decoder rev4: WebCodecs (${demuxed.codec})\n` +
        `${width}x${height}x${frames} of ${demuxed.width}x${demuxed.height}x${demuxed.frames}\n` +
        `decoded in ${(totalMs / 1000).toFixed(1)}s, ${stored}/${frames} frames stored\n` +
        `exact ${demuxed.framesPerSecond.toFixed(3)} fps from the container -- no rate assumed`;

    console.log(diagnostics);
    webcodecs.release();

    const id = nextId++;
    pending.set(id, new Blob([texels]));

    return {
        id,
        width, height, frames,
        sourceFrames: demuxed.frames,
        framesPerSecond: demuxed.framesPerSecond,
        diagnostics,
    };
}

async function decodeWithVideoElement(source, maxDimension, maxBytes, offsetX, offsetY, offsetFrame) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    // DIAGNOSTIC: native size, fully opaque, on top of everything.
    //
    // Firefox Android returned black frames both when this was 1px at
    // opacity 0.01 and when it was 128x72 at opacity 0.01. This removes every
    // remaining way the browser could consider the element not worth painting,
    // at the cost of the video being plainly visible while decoding. If frames
    // still come back black with this, the readback path is broken outright
    // rather than being an occlusion or visibility optimisation, and no amount
    // of styling will fix it.
    video.style.cssText =
        'position:fixed; left:0; top:0; opacity:1; pointer-events:none; z-index:5;';
    document.body.appendChild(video);

    video.src = source;

    try {
        return await decodeInto(video, maxDimension, maxBytes, offsetX, offsetY, offsetFrame);
    } finally {
        // Always: a decode that throws part way through must not leave a stray
        // element in the page still holding a decoder open.
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
    }
}

async function decodeInto(video, maxDimension, maxBytes, offsetX, offsetY, offsetFrame, textureUid) {
    await once(video, 'loadedmetadata', 30000);

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const duration = video.duration;

    if (!sourceWidth || !sourceHeight)
        throw new Error('the video reported no dimensions');
    if (!isFinite(duration) || duration <= 0)
        throw new Error('the video reported no usable duration');

    const sourceFrames = Math.max(1, Math.round(duration * TARGET_FPS));
    const size = sizeFor(sourceWidth, sourceHeight, sourceFrames, maxDimension, maxBytes);
    const { width, height, frames } = size;

    // Where the surviving window sits on each axis. The budget fixes how much
    // survives; this is the user's choice of which part -- so an off-centre
    // subject need not be cropped away. Clamped rather than trusted, since a
    // stale offset from a previous clip would otherwise read outside the source.
    const place = (offset, sourceSize, keptSize) =>
        Math.max(0, Math.min(sourceSize - keptSize, Math.round(offset ?? (sourceSize - keptSize) / 2)));

    const cropX = place(offsetX, sourceWidth, width);
    const cropY = place(offsetY, sourceHeight, height);
    const firstFrame = place(offsetFrame, sourceFrames, frames);

    const bytesPerFrame = width * height * 4;

    // Two ways to keep a frame: straight into the volume texture on the GPU, or
    // through a canvas into a byte buffer. The GPU route is used when the caller
    // supplies a texture, and is the only one that works on Firefox Android.
    const toTexture = textureUid !== undefined && textureUid !== null;

    if (toTexture)
        volume.begin(textureUid, sourceWidth, sourceHeight);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    // NOT willReadFrequently, despite every frame being read back.
    //
    // That hint forces a CPU-backed canvas, and a hardware-decoded video frame
    // often cannot be drawn into one: drawImage silently yields black, with no
    // error anywhere. Measured on Firefox Android as "frames with picture:
    // 0/351, brightest sample 0" while playback was otherwise working. The
    // readback is a little slower on a GPU-backed canvas, but pixel work was
    // only 1% of decode time, so it costs nothing that matters.
    const context = canvas.getContext('2d');

    const texels = new Uint8Array(bytesPerFrame * frames);

    const plan = {
        width, height, frames, cropX, cropY, firstFrame, bytesPerFrame,
        fps: TARGET_FPS, duration,
        toTexture,
    };

    // Seeking is catastrophically slow -- measured at ~354ms per frame, 99% of
    // total decode time, because each seek makes the browser find a keyframe and
    // decode forward to the target. Playing the clip instead decodes every frame
    // once, in order, at hardware speed. Frames arrive via
    // requestVideoFrameCallback, which reports each frame's own presentation
    // time, so they can be filed into the right slice without trusting the clock.
    const started = performance.now();
    const filled = new Uint8Array(frames);
    let captured = 0;
    let playbackRate = 0;

    let passes = 0;

    if (typeof video.requestVideoFrameCallback === 'function') {
        const hz = await measureRefreshHz();
        // Never below 1x: slowing the clip down would only lengthen the capture
        // without gaining frames.
        playbackRate = Math.max(1, Math.min(MAX_PLAYBACK_RATE, (hz / TARGET_FPS) * REFRESH_HEADROOM));

        // Replaying is far cheaper than seeking: a whole extra pass costs a few
        // seconds, while the frames it recovers would cost ~350ms each. Each
        // pass starts at the first hole and skips slices already filled, and the
        // loop stops as soon as a pass gains nothing.
        while (captured < frames && passes < MAX_PLAYBACK_PASSES) {
            const startIndex = filled.indexOf(0);
            if (startIndex < 0)
                break;

            passes++;
            const gained = await capturePlaying(
                video, context, texels, plan, filled, playbackRate, startIndex);
            captured += gained;

            if (gained === 0)
                break;
        }
    }

    // Whatever playback missed -- dropped frames, or no rVFC in this browser --
    // falls back to seeking. Usually a handful; occasionally all of them.
    let seeks = 0;
    for (let i = 0; i < frames; i++) {
        if (filled[i])
            continue;
        await grabBySeeking(video, context, texels, plan, i);
        filled[i] = 1;
        seeks++;
    }

    const totalMs = performance.now() - started;
    console.log(`decode: ${frames} frames in ${(totalMs / 1000).toFixed(1)}s ` +
                `(${captured} while playing at ${playbackRate.toFixed(2)}x on a ${refreshHz}Hz display ` +
                `over ${passes} pass(es), ` +
                `${seeks} by seeking)`);

    // The GPU route never fills a byte buffer, so the byte-level checks below do
    // not apply to it -- the equivalent question is how many slices were written.
    if (toTexture) {
        // Sampled before the state is torn down.
        const sample = volume.sampleSlice(Math.floor(frames / 2), width, height);
        const uploaded = volume.end();

        if (uploaded === 0)
            throw new Error('no frames reached the volume texture');

        const gpuDiagnostics =
            (fallbackReason ? `FELL BACK: ${fallbackReason}\n` : '') +
            `decoder rev5: GPU upload (no canvas, no CPU copy)\n` +
            `${width}x${height}x${frames} of ${sourceWidth}x${sourceHeight}x${sourceFrames}\n` +
            `decoded in ${(totalMs / 1000).toFixed(1)}s, ${uploaded}/${frames} slices uploaded\n` +
            `${captured} played over ${passes} pass(es), ${seeks} seeked\n` +
            `${sample}`;

        console.log(gpuDiagnostics);

        return {
            width, height, frames,
            sourceFrames,
            framesPerSecond: TARGET_FPS,
            diagnostics: gpuDiagnostics,
        };
    }

    // Did any actual picture arrive?
    //
    // This is the one measurement that splits a black cuboid in half: if every
    // frame is pure black then the fault is here, in getting pixels out of the
    // <video> -- which is exactly what a mobile browser does when it declines to
    // decode a video it considers invisible. If frames do have content, decoding
    // is fine and the fault is downstream in the upload or the shader.
    //
    // Sampled rather than scanned: the buffer runs to hundreds of megabytes.
    let framesWithContent = 0;
    let brightest = 0;
    const samplesPerFrame = 32;

    for (let f = 0; f < frames; f++) {
        const base = f * bytesPerFrame;
        let any = false;

        for (let s = 0; s < samplesPerFrame; s++) {
            // Spread across the frame, and aligned to a pixel so the alpha byte
            // (always 255) is never mistaken for picture.
            const pixel = Math.floor((s / samplesPerFrame) * width * height);
            const at = base + pixel * 4;
            const value = Math.max(texels[at], texels[at + 1], texels[at + 2]);

            if (value > brightest)
                brightest = value;
            if (value > 8)
                any = true;
        }

        if (any)
            framesWithContent++;
    }

    // Firefox Android returns pure black from drawImage + getImageData for a
    // video, even a visible, natively sized, playing one (§13). Left to itself
    // that produces a perfectly black cuboid and no error at all, which is
    // indistinguishable from a bug in the shader or the upload. Failing here
    // turns it into something a user can report and a developer can act on.
    if (framesWithContent === 0)
        throw new Error(
            'this browser returned no picture from <video> (every frame was black). '
            + 'Firefox on Android does this and has no WebCodecs either, so it has no '
            + 'working decode path yet -- see WEB-PORT-HANDOFF.md §13.');

    const diagnostics =
        (fallbackReason ? `FELL BACK: ${fallbackReason}\n` : '') +
        // Names the readback strategy, and doubles as a cache check: if this
        // line is missing or stale, the browser is running an old decode.js and
        // the result says nothing about the current code.
        `decoder rev3: canvas readback via <video>\n` +
        `${width}x${height}x${frames} of ${sourceWidth}x${sourceHeight}x${sourceFrames}\n` +
        `decoded in ${(totalMs / 1000).toFixed(1)}s: ${captured} played, ${seeks} seeked, ${passes} pass(es)\n` +
        `rVFC ${typeof video.requestVideoFrameCallback === 'function' ? 'yes' : 'NO'}, ` +
        `rate ${playbackRate.toFixed(2)}x, display ${refreshHz}Hz\n` +
        `frames with picture: ${framesWithContent}/${frames}, brightest sample ${brightest}`;

    console.log(diagnostics);

    const id = nextId++;
    // A Blob rather than the raw Uint8Array: Blazor accepts either when
    // streaming to .NET, but a Blob hands ownership of the bytes to the browser
    // so the buffer can be freed once it has been read.
    pending.set(id, new Blob([texels]));

    return {
        id,
        width,
        height,
        frames,
        sourceFrames,
        diagnostics,
        // Slices are one source frame apart, so the volume's own rate is the
        // source's rate -- which is what makes a peel or slice take exactly the
        // wall-clock time the surviving footage lasts.
        framesPerSecond: TARGET_FPS,
    };
}

/// Hands the parked pixels to .NET as a stream and releases them.
///
/// Returns the Blob raw. Do NOT wrap it in DotNet.createJSStreamReference():
/// when the .NET side declares the return type as IJSStreamReference, Blazor
/// applies that conversion itself to whatever this returns. Wrapping it here
/// makes Blazor try to convert the resulting descriptor a second time, which
/// fails with "Supplied value is not a typed array or blob" -- an error that
/// points at the value rather than at the double conversion.
export function takePixels(id) {
    const pixels = pending.get(id);
    if (!pixels)
        throw new Error(`no decoded pixels for id ${id} (have: ${[...pending.keys()].join(',') || 'none'})`);

    pending.delete(id);
    return pixels;
}
