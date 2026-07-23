// Drag handling for the crop sliders.
//
// These are not <input type=range>: that draws a knob, which says "one value
// here", when what is being chosen is a window -- a span of fixed width sliding
// along the full extent of an axis. So each control is a track with a bar in it,
// the bar's length showing how much of the axis survives the budget and its
// position showing which part.
//
// Every track is laid out horizontally and then rotated, so one piece of maths
// serves all three: X at 0 degrees, Z on the diagonal, Y turned upright.

let dotNet = null;
const axes = new Map();

/// Projects a pointer onto a track's own long axis, which is what makes the
/// rotated sliders work: getBoundingClientRect is axis-aligned and useless for a
/// rotated element, but the centre it reports is still correct, and the
/// direction is known because we chose the angle.
function fractionAt(axis, event) {
    const rect = axis.track.getBoundingClientRect();
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;

    const radians = axis.angle * Math.PI / 180;
    const along = (event.clientX - centreX) * Math.cos(radians)
                + (event.clientY - centreY) * Math.sin(radians);

    return 0.5 + along / axis.length;
}

function layout(axis) {
    const spanPercent = axis.span * 100;
    const travel = axis.max > 0 ? axis.offset / axis.max : 0;

    axis.bar.style.width = spanPercent + '%';
    axis.bar.style.left = (travel * (100 - spanPercent)) + '%';
}

function setOffset(axis, offset) {
    const clamped = Math.max(0, Math.min(axis.max, Math.round(offset)));
    if (clamped === axis.offset)
        return;

    axis.offset = clamped;
    layout(axis);

    // Reported as it moves so the readout tracks the drag. This only updates
    // numbers -- decoding waits for the button, because it costs seconds.
    if (dotNet)
        dotNet.invokeMethodAsync('SetCropOffset', axis.name, clamped);
}

function pointerToOffset(axis, event) {
    if (axis.max <= 0 || axis.span >= 1)
        return;

    // The bar's centre follows the pointer, kept far enough from each end that
    // the bar stays wholly on the track.
    const half = axis.span / 2;
    const centre = Math.max(half, Math.min(1 - half, fractionAt(axis, event)));
    setOffset(axis, ((centre - half) / (1 - axis.span)) * axis.max);
}

function attach(axis) {
    if (axis.max <= 0)
        return;

    axis.track.style.cursor = 'grab';

    axis.track.addEventListener('pointerdown', (event) => {
        // Capture so a fast drag that leaves the small track keeps working, and
        // so the release is still seen wherever it happens.
        axis.track.setPointerCapture(event.pointerId);
        axis.track.style.cursor = 'grabbing';
        axis.dragging = true;
        pointerToOffset(axis, event);
        event.preventDefault();
    });

    axis.track.addEventListener('pointermove', (event) => {
        if (axis.dragging)
            pointerToOffset(axis, event);
    });

    const release = (event) => {
        axis.dragging = false;
        axis.track.style.cursor = 'grab';
        if (axis.track.hasPointerCapture(event.pointerId))
            axis.track.releasePointerCapture(event.pointerId);
    };

    axis.track.addEventListener('pointerup', release);
    axis.track.addEventListener('pointercancel', release);
}

/// Called whenever a new clip is planned: the spans change with the budget, so
/// the tracks are rebuilt rather than adjusted.
export function init(reference, specs) {
    dotNet = reference;
    axes.clear();

    for (const spec of specs) {
        const track = document.querySelector(`.cropTrack[data-axis="${spec.name}"]`);
        if (!track)
            continue;

        const axis = {
            ...spec,
            track,
            bar: track.querySelector('.cropBar'),
            dragging: false,
        };

        axes.set(spec.name, axis);
        layout(axis);
        attach(axis);
    }
}
