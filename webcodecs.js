// Decoding through WebCodecs: demux the container ourselves with mp4box, then
// hand the encoded samples to the platform's VideoDecoder.
//
// This exists because the <video> route has two problems that cannot be fixed
// from inside it:
//
//   * Speed. A <video> only yields frames as fast as it presents them, and
//     requestVideoFrameCallback fires at most once per display refresh -- so a
//     351-frame clip takes tens of seconds, and every frame the compositor drops
//     costs a ~350ms seek to recover. (This clip has 2 keyframes in 351 frames,
//     which is why seeking is so expensive.) A VideoDecoder runs as fast as the
//     hardware allows and never involves the display at all.
//
//   * Correctness. The <video> path has to guess the frame rate, because the
//     browser will not report a frame count -- and frames recovered by seeking
//     were then indexed against that guess while played frames were indexed by
//     their real timestamps. Those two disagree on anything that is not exactly
//     30fps, which is the temporal jitter in WEB-PORT-HANDOFF.md §12. Here the
//     container gives the exact sample count and exact composition times, so
//     there is nothing to guess and only one way of indexing.
//
// Not available everywhere: Firefox Android has no WebCodecs at all (§12), so
// decode.js keeps the <video> path as a fallback.

// Same versioning as decode.js: taken from this module's own URL so the whole
// graph moves together.
const VERSION = new URL(import.meta.url).searchParams.get('v') ?? '';
const { createFile, MP4BoxBuffer, DataStream, Endianness } =
    await import(`./vendor/mp4box/mp4box.all.mjs${VERSION ? `?v=${VERSION}` : ''}`);

export function supported() {
    return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

// Demuxing costs a fetch of the whole file, and both planning and decoding need
// it. Kept per source so choosing a crop and then decoding does not fetch twice.
let cached = null;

/// Reads the container: track metadata, every encoded sample, and the codec
/// description VideoDecoder.configure() requires.
export async function demux(source) {
    if (cached && cached.source === source)
        return cached;

    const response = await fetch(source);
    if (!response.ok)
        throw new Error(`fetching ${source} failed: ${response.status}`);

    const buffer = await response.arrayBuffer();
    const file = createFile();

    let track = null;
    const samples = [];
    let failure = null;

    file.onError = (error) => { failure = error; };

    file.onReady = (info) => {
        track = info.videoTracks[0];
        if (!track)
            return;

        // Options before the buffer is fed: samples are emitted as it is
        // parsed, so asking afterwards returns nothing at all.
        file.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
        file.start();
    };

    file.onSamples = (id, user, batch) => {
        for (const sample of batch) {
            samples.push({
                data: sample.data,
                cts: sample.cts,
                timescale: sample.timescale,
                isKey: !!sample.is_sync,
                duration: sample.duration,
            });
        }
    };

    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
    file.flush();

    if (failure)
        throw new Error(`mp4box: ${failure}`);
    if (!track)
        throw new Error('no video track in this file');
    if (samples.length === 0)
        throw new Error('no video samples could be extracted');

    // Samples arrive in DECODE order, which is not display order once there are
    // B-frames. Sorting the composition times gives the true presentation order,
    // and with it the exact slice each frame belongs to -- no frame rate is
    // assumed anywhere.
    const order = new Map();
    [...samples]
        .map(s => s.cts)
        .sort((a, b) => a - b)
        .forEach((cts, index) => order.set(cts, index));

    cached = {
        source,
        samples,
        order,
        description: codecDescription(file, track.id),
        codec: track.codec,
        width: track.video.width,
        height: track.video.height,
        frames: samples.length,
        timescale: track.timescale,
        // Exact, from the container, rather than assumed.
        framesPerSecond: samples.length / (track.duration / track.timescale),
    };

    return cached;
}

/// The raw avcC/hvcC/av1C record, which VideoDecoder needs to make sense of the
/// samples. Absent for Annex-B streams, where configure() is given no
/// description at all.
function codecDescription(file, trackId) {
    const trak = file.getTrackById(trackId);

    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (!box)
            continue;

        const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
        box.write(stream);
        // Skip the 8-byte box header; configure() wants the payload only.
        return new Uint8Array(stream.buffer, 8);
    }

    return null;
}

/// Decodes the frames in [firstFrame, firstFrame + frames) into `texels`,
/// cropping each one as it arrives.
///
/// Every sample is submitted, not just the wanted ones: inter-frame compression
/// means a frame is only decodable after everything it references, and this clip
/// carries just two keyframes. Frames outside the window are closed immediately
/// rather than stored.
export async function decodeFrames(demuxed, plan, texels, storeFrame) {
    const wanted = new Set();
    for (let i = 0; i < plan.frames; i++)
        wanted.add(plan.firstFrame + i);

    let stored = 0;
    let failure = null;

    const decoder = new VideoDecoder({
        output: (frame) => {
            try {
                // Back to a composition time, then to its presentation index --
                // the frame's own timestamp, never a clock or a counter.
                const cts = Math.round((frame.timestamp * demuxed.timescale) / 1e6);
                const index = demuxed.order.get(cts);

                if (index !== undefined && wanted.has(index)) {
                    storeFrame(frame, index - plan.firstFrame);
                    stored++;
                }
            } finally {
                // Always: VideoFrames hold real decoder buffers and a leak stalls
                // the decoder within a few frames.
                frame.close();
            }
        },
        error: (error) => { failure = error; },
    });

    const config = {
        codec: demuxed.codec,
        codedWidth: demuxed.width,
        codedHeight: demuxed.height,
    };
    if (demuxed.description)
        config.description = demuxed.description;

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported)
        throw new Error(`this browser cannot decode ${demuxed.codec}`);

    decoder.configure(config);

    for (const sample of demuxed.samples) {
        if (failure)
            break;

        decoder.decode(new EncodedVideoChunk({
            type: sample.isKey ? 'key' : 'delta',
            timestamp: (sample.cts * 1e6) / sample.timescale,
            duration: (sample.duration * 1e6) / sample.timescale,
            data: sample.data,
        }));

        // Let the event loop breathe: WASM and JS share one thread, and queueing
        // hundreds of chunks without yielding starves the decoder's callbacks.
        if (decoder.decodeQueueSize > 32)
            await new Promise(resolve => setTimeout(resolve, 0));
    }

    await decoder.flush();
    decoder.close();

    if (failure)
        throw new Error(`VideoDecoder: ${failure}`);

    return stored;
}

/// Frees the cached file once a decode is done with it -- these run to tens of
/// megabytes and there is no reason to hold one after the volume is built.
export function release() {
    cached = null;
}
