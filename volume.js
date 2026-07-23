// Uploading video frames straight into the volume texture, on the GPU.
//
// This exists for Firefox Android, which will not give up video pixels any other
// way (WEB-PORT-HANDOFF.md 13): drawImage + getImageData returns pure black even
// for a visible, natively sized, playing video, and it has no WebCodecs. What it
// will do is hand a frame to WebGL. Measured on the device:
//
//   texImage2D(TEXTURE_2D, ..., video)          -> works
//   texSubImage3D(TEXTURE_3D, ..., video)       -> REJECTED, GL error 0x505
//   texImage2D then copyTexSubImage3D to a slice -> works
//
// So each frame goes into a scratch 2D texture, and is then copied from a
// framebuffer backed by that texture into one slice of the volume. Nothing
// touches a canvas, and nothing crosses into WASM: the ~192 MiB round trip the
// canvas path needs disappears entirely.

let state = null;

/// The WebGL2 context KNI is already drawing with.
///
/// getContext returns the *same* context for a canvas rather than making a new
/// one, so this needs no plumbing through .NET -- and it must be the same one,
/// since a texture belongs to the context that created it.
function contextForCanvas() {
    const canvas = document.getElementById('theCanvas');
    if (!canvas)
        throw new Error('the game canvas is not in the page');

    const gl = canvas.getContext('webgl2');
    if (!gl)
        throw new Error('the canvas has no WebGL2 context');

    return gl;
}

/// Resolves the KNI-side texture. nkast.Wasm keeps its JS objects in a registry
/// keyed by a uid, which is what Texture3D.GetSharedHandle returns.
function textureForUid(uid) {
    if (typeof nkJSObject === 'undefined' || !nkJSObject.GetObject)
        throw new Error('nkast.Wasm JSObject registry is not loaded');

    const texture = nkJSObject.GetObject(uid);
    if (!texture)
        throw new Error(`no WebGL texture registered for uid ${uid}`);

    return texture;
}

/// How to get an ImageBitmap into the scratch texture TOP-DOWN -- texture row 0
/// holding the picture's top row. Null until measured.
///
/// Top-down is what the rest of the app means by a volume: VolumeBuilder.SetData
/// hands over rows starting at the picture's top, so texture row 0 is the top,
/// and Cuboid.ToVolumeCoord maps that to v = 0. The GPU path has to land in the
/// same place as the byte path or the two disagree about which way up a clip is.
///
/// Measured rather than assumed because the levers are unreliable and the
/// failure is nearly silent. An ImageBitmap carries its own orientation, fixed
/// when it was created, and browsers have differed over whether
/// UNPACK_FLIP_Y_WEBGL may then override it. Get it wrong and the sheet goes in
/// upside down -- which on a box you can spin looks like nothing at all, so what
/// you actually notice is tile row r being read out of band (rows-1-r),
/// reversing the tile rows inside every sheet and scrambling time. That is a
/// long way to chase from the symptom, and two 1x2 uploads settle it.
let sheetNeedsUnpackFlip = null;
let sheetOrientationNote = 'not probed';

/// What the probe found, for the diagnostics panel.
export function orientationReport() {
    return `sheet upload: ${sheetOrientationNote}`;
}

/// A 1x2 PNG, top pixel red, bottom pixel green -- the smallest encoded image
/// that can answer "which way up did this arrive?".
///
/// Inline rather than fetched: the probe runs before the first sheet, and a
/// network round trip that could fail would put an orientation question behind
/// a connectivity one. PNG so the two colours come back exactly, with no codec
/// in the way of the comparison.
const PROBE_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAADklEQVR42mP4zwAE/xkACP8B/11JYlgAAAAASUVORK5CYII=';

function probeBlob() {
    const binary = atob(PROBE_PNG);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);

    return new Blob([bytes], { type: 'image/png' });
}

/// Decodes an encoded image into something texImage2D will take, by the one
/// route whose orientation is unambiguous.
///
/// An HTMLImageElement, NOT createImageBitmap, and this is the fix for three
/// rounds of upside-down volumes. An ImageBitmap carries its own orientation,
/// decided when it was created, and here NEITHER lever moved it: asking for
/// `imageOrientation: 'flipY'`, asking for `'none'`, and setting
/// UNPACK_FLIP_Y_WEBGL all produced the same bottom-up sheet. texImage2D from an
/// <img> is the oldest path in WebGL and has exactly one meaning everywhere:
/// image row 0 becomes texture row 0.
///
/// Exported so decode.js loads sheets through this very function. The probe and
/// the thing it measures must travel the same road -- a probe that does not is
/// worse than none, because it is confidently wrong, which is precisely how the
/// ImageData version of it sent this the wrong way.
export async function decodeImage(blob) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const release = () => { URL.revokeObjectURL(url); image.removeAttribute('src'); };

    try {
        image.src = url;

        // decode() resolves once the pixels are actually ready, so an upload
        // cannot catch a half-decoded sheet. The load event is the fallback for
        // anything without it.
        if (typeof image.decode === 'function')
            await image.decode();
        else
            await new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('the sheet failed to load'));
            });
    } catch (error) {
        release();
        throw new Error(`could not decode a sheet: ${error.message ?? error}`);
    }

    return { image, release };
}

/// Works out, on this device, which combination lands a bitmap bottom-up.
/// Cached: it costs two 1x2 uploads and never changes within a session.
export async function probeSheetOrientation() {
    if (sheetNeedsUnpackFlip !== null)
        return sheetNeedsUnpackFlip;

    const gl = contextForCanvas();

    // Through decodeImage, which is what loads the real sheets. Same road.
    const decoded = await decodeImage(probeBlob());
    const bitmap = decoded.image;

    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    const pixels = new Uint8Array(8);

    // True when the picture's TOP row ends up at framebuffer row 0, which is the
    // arrangement copyRegion reads from.
    const landsTopDown = (unpackFlip) => {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, unpackFlip);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

        if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            return null;

        gl.readPixels(0, 0, 1, 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Framebuffer row 0 is texture row 0. Red there means the picture's top
        // row landed there, which is what the byte path also produces.
        return pixels[0] > pixels[1];
    };

    try {
        if (landsTopDown(false) === true) {
            sheetNeedsUnpackFlip = false;
            sheetOrientationNote = '<img> lands top-down; no unpack flip (expected)';
        } else if (landsTopDown(true) === true) {
            sheetNeedsUnpackFlip = true;
            sheetOrientationNote = '<img> arrives flipped; corrected with UNPACK_FLIP_Y_WEBGL';
        } else {
            // Neither arrangement measured top-down. Take the plain one and say
            // so -- a wrong guess here is exactly the bug this probe exists to
            // catch, so it must not be silent.
            sheetNeedsUnpackFlip = false;
            sheetOrientationNote = 'PROBE INCONCLUSIVE -- frame order may be wrong';
        }
    } catch (error) {
        sheetNeedsUnpackFlip = false;
        sheetOrientationNote = `probe threw (${error}); assuming no flip`;
    } finally {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        decoded.release();
    }

    console.log(`volume: ${sheetOrientationNote}`);
    return sheetNeedsUnpackFlip;
}

/// Prepares to fill a volume: `uid` names the Texture3D, and the source size is
/// that of whatever gets uploaded whole and cropped on the way out -- one video
/// frame on the video path, one atlas sheet on the fallback path. The size is
/// only checked, not kept: nothing downstream needs it now that no coordinate
/// gets flipped.
export function begin(uid, sourceWidth, sourceHeight) {
    const gl = contextForCanvas();

    // Checked rather than attempted. An atlas sheet is far larger than a video
    // frame -- 3840x3888 for the bundled clip -- and a device whose
    // MAX_TEXTURE_SIZE cannot hold one fails inside texImage2D with a bare GL
    // error code that says nothing about which dimension was too big. WebGL2
    // only guarantees 2048, so this is reachable in principle even though every
    // handset measured reports 4096 or more; build-content-atlas.sh caps sheets
    // with MAX_SHEET, and this is the other end of that contract.
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (sourceWidth > limit || sourceHeight > limit)
        throw new Error(
            `a ${sourceWidth}x${sourceHeight} source exceeds this device's `
            + `MAX_TEXTURE_SIZE of ${limit}; rebuild the atlas with MAX_SHEET=${limit}`);

    const scratch = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, scratch);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    state = {
        gl,
        volume: textureForUid(uid),
        scratch,
        framebuffer: gl.createFramebuffer(),
        uploaded: 0,
    };
}

/// Puts one picture -- a video frame, or a whole atlas sheet -- into the scratch
/// 2D texture, ready for one or more copies out of it.
///
/// Anything WebGL accepts as a texture source works here; the atlas path hands
/// it an ImageBitmap rather than a <video>.
///
/// `flipOnUpload` says whether this source still needs turning over. Everything
/// downstream -- copyRegion in particular -- assumes the scratch texture holds
/// the picture bottom-up, and the ONLY question is who did the turning.
///
///   <video>      UNPACK_FLIP_Y_WEBGL, here. Known good, unchanged.
///   ImageBitmap  createImageBitmap({ imageOrientation: 'flipY' }), by the
///                caller -- so this must NOT flip it a second time.
///
/// The split exists because UNPACK_FLIP_Y_WEBGL is not reliably honoured for an
/// ImageBitmap source: an ImageBitmap carries its own orientation, decided when
/// it was created, and browsers have differed over whether the unpack parameter
/// may override it. Relying on it left every atlas sheet the right way up as far
/// as the eye could tell -- a mirrored volume is invisible on a box you can spin
/// -- while reading tile row r out of band (rows-1-r), which reversed the tile
/// rows inside every sheet and scrambled time in exactly that pattern. Deciding
/// the orientation at creation is unambiguous; this flag records which half of
/// the contract each caller holds.
function uploadScratch(source, flipOnUpload) {
    const gl = state.gl;

    // Set explicitly rather than only cleared afterwards. KNI draws between
    // sheets -- the game loop keeps running through the awaits in the atlas
    // path -- and this is global GL state that anything else may have left set.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipOnUpload);
    gl.bindTexture(gl.TEXTURE_2D, state.scratch);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const error = gl.getError();
    if (error !== gl.NO_ERROR)
        throw new Error(`uploading the picture failed, GL error 0x${error.toString(16)}`);

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.framebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.scratch, 0);

    if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('the scratch texture cannot be read from');
}

/// Copies a rectangle of whatever is in the scratch texture into slice `z`.
///
/// (srcX, srcY) is measured from the TOP left, like every other coordinate in
/// this app, and no flip happens anywhere: the scratch texture is top-down (see
/// probeSheetOrientation), copyTexSubImage3D reads upward from srcY into the
/// slice from its row 0, and so slice row 0 receives the top of the picture --
/// the same thing VolumeBuilder.SetData produces on the byte path, and the v = 0
/// end Cuboid.ToVolumeCoord expects.
///
/// This used to flip on upload and read from `sourceHeight - srcY - height`,
/// which is self-consistent but lands the picture's BOTTOM at slice row 0 --
/// upside down against the byte path. It survived because the GPU path only
/// runs where WebCodecs is absent, and the one browser that took it rendered a
/// flat fill, so there was never a picture to see the wrong way up.
function copyRegion(z, srcX, srcY, width, height) {
    const gl = state.gl;

    gl.bindTexture(gl.TEXTURE_3D, state.volume);
    gl.copyTexSubImage3D(gl.TEXTURE_3D, 0, 0, 0, z, srcX, srcY, width, height);

    const error = gl.getError();
    if (error !== gl.NO_ERROR)
        throw new Error(`copying into slice ${z} failed, GL error 0x${error.toString(16)}`);

    state.uploaded++;
}

/// Copies the frame currently showing in `video` into slice `z` of the volume,
/// taking the crop rectangle from (cropX, cropY).
export function uploadSlice(video, z, cropX, cropY, width, height) {
    if (!state)
        throw new Error('uploadSlice called before begin');

    // No flip: a <video> uploads top-down by default, which is the orientation
    // copyRegion wants. Same convention as the atlas path.
    uploadScratch(video, false);
    copyRegion(z, cropX, cropY, width, height);
}

/// Puts an atlas sheet in the scratch texture, to be drained by copyTile.
///
/// Split from the copy because a sheet holds tileCols x tileRows frames: the
/// upload happens once and is then read 45 times, where the video path uploads
/// per frame. That is the whole reason the atlas is cheap to load.
///
/// `image` is created with imageOrientation 'flipY'; whether that alone lands it
/// bottom-up is what probeSheetOrientation measured. Getting it wrong reverses
/// the tile rows within every sheet and is close to invisible except as
/// scrambled time, so this must not be a guess -- probe first.
export function uploadSheet(image) {
    if (!state)
        throw new Error('uploadSheet called before begin');
    if (sheetNeedsUnpackFlip === null)
        throw new Error('uploadSheet called before probeSheetOrientation');

    uploadScratch(image, sheetNeedsUnpackFlip);
}

/// Copies one tile of the sheet currently in the scratch texture into slice `z`.
/// (srcX, srcY) is the tile's origin plus the crop offset, from the top left of
/// the whole sheet.
export function copyTile(z, srcX, srcY, width, height) {
    if (!state)
        throw new Error('copyTile called before begin');

    copyRegion(z, srcX, srcY, width, height);
}

/// Reads a few texels back out of a slice, to tell "the copy wrote rubbish" from
/// "the copy was fine and something downstream is wrong". Those have completely
/// different fixes and look identical on screen.
export function sampleSlice(z, width, height) {
    if (!state)
        return 'no upload state';

    const gl = state.gl;

    try {
        const check = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, check);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, state.volume, 0, z);

        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.deleteFramebuffer(check);
            return 'slice not readable';
        }

        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(check);

        // A handful spread across the slice, plus the range, which is what
        // separates "a constant colour" from "an actual picture".
        const shown = [];
        let min = 255, max = 0;
        for (let i = 0; i < 5; i++) {
            const at = Math.floor((i / 5) * width * height) * 4;
            shown.push(`${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`);
        }
        for (let i = 0; i < pixels.length; i += 4) {
            for (let c = 0; c < 3; c++) {
                min = Math.min(min, pixels[i + c]);
                max = Math.max(max, pixels[i + c]);
            }
        }

        return `slice ${z} rgb [${shown.join('] [')}] range ${min}..${max}`;
    } catch (error) {
        return `slice read threw ${error}`;
    }
}

/// Releases the scratch objects and reports how many slices were written, so the
/// caller can tell a silent partial fill from a complete one.
export function end() {
    if (!state)
        return 0;

    const gl = state.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.deleteFramebuffer(state.framebuffer);
    gl.deleteTexture(state.scratch);

    const uploaded = state.uploaded;
    state = null;
    return uploaded;
}
