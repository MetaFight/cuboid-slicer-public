// Motion controls: the phone flies the camera, and the cut is the screen.
//
// The slicing plane is welded to the view -- it always faces you, filling the
// window -- so what the sensors move is the camera around it. Turn the handset
// and the box turns under the blade. Every pose therefore shows a
// cross-section, and exploring is just looking around.
//
// Aim is all this sends now. Depth was the accelerometer's job and is the
// pinch's instead, through the camera's distance from the box: the blade is
// held a fixed reach in front of the eye, so closing on the box carries it
// through. What is left here is still integrated, but only for the readout --
// see OffsetHalfLife.
//
// A classic script rather than a module, and wired to a plain onclick rather
// than @onclick, because iOS only grants sensor permission from inside a real
// user gesture -- a round trip through Blazor spends the activation and the
// request is refused. Same reason copyDiagnosticsJS is wired the way it is.
//
// The readout this pushes to the page is not a nicety. Every browser gates
// these sensors differently -- iOS prompts, Chrome wants a secure context and
// silently fires nothing without one, desktop defines the events and never
// fires them, and some engines deliver one event with all-null fields to mean
// "no data" -- and all of those failures look identical from the outside: a box
// that does not move. The panel exists so they can be told apart on a phone,
// where there is no console to ask.

(function ()
{
    // Below this the reading is the sensor's own noise, not a push. Without it
    // the plane creeps through the box while the phone sits still.
    const NoiseFloor = 0.12;      // m/s^2

    // Velocity from an accelerometer is an integral, so its error grows without
    // bound: every reading's noise is kept forever. Bleeding it away trades
    // absolute travel for a control that returns to a known state instead of
    // wandering off. How much of each is the whole design question, and these
    // two constants are where it is answered.
    //
    // Damp a double integrator hard enough and it stops behaving like one: the
    // output tracks the *input*, so the number follows how hard the phone is
    // being shoved rather than how far it has gone. At the original 0.35s that
    // is what this was -- a pressure pad -- and it showed: moving the handset at
    // a steady rate produced nothing at all, because steady motion has no
    // acceleration in it to track.
    //
    // Chosen by simulating the gesture that actually happens -- accelerate,
    // then decelerate back to rest -- rather than by feel. Against a real 25 cm
    // movement, this reads 25.1 cm as the hand stops and still 23.6 cm three
    // seconds later. Shorter sags (at 4s: 18 cm by then, at 2s: 11 cm), and
    // that sag is what the old 0.35s was made of.
    //
    // Longer is not better, which is the non-obvious part: past about this
    // value the leftover velocity error never dies either, so instead of
    // settling the reading creeps on upward -- at 16s the same 25 cm gesture
    // reads 29.6 cm ten seconds later, still climbing. This is roughly where
    // hold is flattest.
    //
    // None of it recovers steady-state travel. An accelerometer moving at
    // constant velocity is indistinguishable from one at rest; that is physics,
    // not tuning. What this buys is that a movement registers for its whole
    // duration instead of only its first moment.
    const VelocityHalfLife = 8.00;  // seconds

    // No spring. Infinity makes decay() return exactly 1, so travel is kept
    // rather than leaked back toward the resting pose.
    //
    // Nothing depends on this being right any more -- the figure reaches the
    // readout and stops there. It is kept because it is the only measurement of
    // what the hand is doing, which is what Tier 2's parallax nudge would need,
    // and because a sensor panel that reports the raw truth is how the dead ones
    // get told apart from the working ones.
    //
    // Left unsprung so it reads as travel rather than as pressure. The cost is
    // that error is permanent: every centimetre the integrator gets wrong is
    // kept for the session. "recentre" zeroes it, which is the way back.
    const OffsetHalfLife = Infinity;

    // The readout is for a human reading a phone screen, so it goes out ten
    // times a second rather than at sensor rate: faster than this and the digits
    // are a blur, and each one costs a render of the page. It is driven by this
    // timer rather than by the sensor handlers precisely so that a sensor which
    // never reports still produces a panel saying so.
    const ReadoutInterval = 100;  // ms

    // Within this of straight up or straight down, a bearing means nothing: the
    // screen faces the sky, and which way the phone is "pointing" is decided by
    // the last shred of horizontal component left. Used only to gate the flip
    // detection below, so it can be generous.
    const PoleZone = Math.cos(25 * Math.PI / 180);   // |facing.z| above this

    const state = {
        enabled: false,
        reference: null,  // bearing and elevation at the moment it was switched on
        raw: [0, 0, 0],   // alpha, beta, gamma exactly as the sensor gave them
        facing: [0, 0, 1],
        yaw: 0,
        pitch: 0,

        // Whether the handset has been tipped over the top (or under the
        // bottom) an odd number of times since switch-on, and the bearing on
        // the previous reading, which is what reveals that it has. See
        // unfold().
        flipped: false,
        lastAzimuth: null,
        // The last elevation on the continuous scale, which is what every new
        // reading is made continuous with. Null until the first one arrives.
        unfolded: null,
        // Velocity and travel along the phone's own three axes. All three are
        // now integrated purely so the readout can show what the sensors think
        // the hand is doing; none of them steers anything.
        velocity: [0, 0, 0],
        offset: [0, 0, 0],
        acceleration: [0, 0, 0],
        gravity: null,    // low-passed, only used where the sensor omits it
        lastMotion: 0,
        source: '',
        timer: 0,

        // What actually happened, for the panel. Events that arrive carrying
        // nothing but nulls are counted apart from real ones: engines use them
        // to say "asked, but no sensor", and counting them as data is what makes
        // a dead sensor look like a working one stuck at zero.
        permission: { orientation: '-', motion: '-' },
        handoffError: '',

        // Which of the two orientation events is actually supplying data, and
        // how many empty ones each of them sent. Worth counting separately:
        // "one event, all fields null" is the signature of a browser that
        // started the listener and then could not source it, and knowing which
        // listener did that is what names the missing sensor.
        aimEvent: '',
        emptyBy: {},

        // The WebXR capability answer taken from inside the button press.
        // Deliberately not cleared by stop(), so switching motion off does not
        // throw away a measurement that took a user gesture to get.
        xrProbe: '',

        orientationEvents: 0,
        motionEvents: 0,
        emptyEvents: 0,
    };

    /// The W3C device rotation matrix for alpha/beta/gamma (Z-X'-Y''), returned
    /// as three world-space axis vectors -- the device's own x, y and z as seen
    /// from the room.
    function basisFrom(alpha, beta, gamma)
    {
        const a = (alpha || 0) * Math.PI / 180;
        const b = (beta || 0) * Math.PI / 180;
        const g = (gamma || 0) * Math.PI / 180;

        const cA = Math.cos(a), sA = Math.sin(a);
        const cB = Math.cos(b), sB = Math.sin(b);
        const cG = Math.cos(g), sG = Math.sin(g);

        return [
            [cA * cG - sA * sB * sG, sA * cG + cA * sB * sG, -cB * sG],
            [-sA * cB, cA * cB, sB],
            [cA * sG + sA * sB * cG, sA * sG - cA * sB * cG, cB * cG],
        ];
    }

    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

    /// How far the picture is turned within the handset, in radians. Absent on
    /// desktop, where there is no such thing and zero is right.
    function screenAngle()
    {
        return ((screen.orientation && screen.orientation.angle) || 0) * Math.PI / 180;
    }

    /// A vector in the phone's own axes, re-expressed in the screen's: across,
    /// up, and out towards the user. The two differ by a quarter turn in
    /// landscape, so anything meant as "sideways to the person holding it" has
    /// to come through here.
    ///
    /// Note where this is NOT applied. Bearing and elevation are taken from the
    /// direction the screen faces, and that direction is the third axis, which a
    /// turn *about* it cannot move -- so the aim is already blind to screen
    /// orientation and rotating the basis first would be a no-op. What is
    /// genuinely device-framed is the accelerometer, whose across and up swap in
    /// landscape. That has been invisible so far only because the blade reads
    /// the out-of-screen axis, the one component the turn leaves alone; the
    /// other two reach the readout today and the parallax nudge later.
    function screenAxes(v)
    {
        const t = screenAngle();
        const c = Math.cos(t), s = Math.sin(t);

        return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
    }

    /// Into (-pi, pi], so passing due north does not swing the camera the long
    /// way round.
    function wrap(radians)
    {
        return Math.atan2(Math.sin(radians), Math.cos(radians));
    }

    /// Makes bearing and elevation continue through straight-up and straight-
    /// down instead of folding back at them.
    ///
    /// A direction written as a bearing plus an elevation has a seam at each
    /// pole, and it is not a rounding problem: tip the handset past flat and the
    /// elevation, which cannot exceed a quarter turn, turns round and comes back
    /// down while the bearing swings a half turn to compensate. Both describe
    /// the same real direction, so nothing is wrong with the numbers -- but fed
    /// to a camera they read as the box spinning half a turn and the tilt
    /// refusing to go any further, which is precisely what it looks like on the
    /// device.
    ///
    /// It bites here rather than in some far corner because the pole is where
    /// people put the phone: hold it out and tilt the top away to look down on
    /// the box and the screen ends up facing the sky, which *is* the seam. Worse,
    /// switching motion on while holding it flat puts the resting pose there, so
    /// the tilt can only ever go one way from home.
    ///
    /// The fix is to count the crossings. Past the pole the continuous reading
    /// is a half turn on in bearing and reflected in elevation, so undoing both
    /// yields angles that keep climbing -- and the camera's own pitch limit then
    /// stops the view at overhead, which is what tipping further should do.
    ///
    /// A crossing is a half-turn jump in bearing while near-vertical. Near-
    /// vertical alone would fire on any brisk turn held flat; a jump alone would
    /// fire on a fast spin held upright. Together they are specific to the seam.
    function unfold(azimuth, elevation)
    {
        if (state.lastAzimuth !== null
            && Math.abs(state.facing[2]) > PoleZone
            && Math.abs(wrap(azimuth - state.lastAzimuth)) > Math.PI / 2)
        {
            state.flipped = !state.flipped;
        }

        state.lastAzimuth = azimuth;

        // Reflected about the pole, so elevation carries on past a quarter turn
        // rather than turning back. Note this is the RAW reflection, with no
        // choice of sign: which side of the seam the reading is on is settled
        // below, by continuity, not by the sign of the elevation.
        let value = state.flipped ? Math.PI - elevation : elevation;

        // Lift onto the continuous scale by picking the turn nearest the last
        // reading.
        //
        // This is what carries the value through elevation = 0, and it is the
        // half that was missing. Reflecting about "whichever pole the sign of
        // the elevation implies" -- PI - e above the horizon, -PI - e below --
        // is self-consistent on each side and jumps a full turn between them,
        // because at e = 0 those two differ by exactly 2*PI. So tipping steadily
        // onward ran 178, 179, 180, then -179: continuous everywhere except the
        // one place a tilt most obviously is not.
        //
        // With the handset flat when motion was switched on -- the common case,
        // and called out above -- the reference elevation is a quarter turn, so
        // that seam landed at exactly 90 degrees of reported pitch. Hence "at
        // 90 it flips to -270", which is the same jump seen through the offset.
        //
        // Snapping to the nearest turn also tracks repeated crossings: each one
        // toggles the reflection, and the turn count follows from continuity
        // rather than being counted, so tipping right over and round again keeps
        // climbing instead of resetting.
        if (state.unfolded !== null)
        {
            const turn = Math.PI * 2;
            value += turn * Math.round((state.unfolded - value) / turn);
        }

        state.unfolded = value;

        return {
            azimuth: state.flipped ? azimuth + Math.PI : azimuth,
            elevation: value,
        };
    }

    /// Turns the pose into the two camera angles the game already orbits by.
    ///
    /// Measured against the pose the phone was in when motion controls came on,
    /// which is what makes this usable anywhere: no compass, no assumption about
    /// sitting upright, and switching on never jumps the view. Turning the
    /// handset right walks the camera right around the box; tipping its top away
    /// lifts the camera to look down on it.
    function onOrientation(event)
    {
        if (!state.enabled)
            return;

        // Two event names are listened for and the first one to carry real data
        // wins; the loser is ignored from then on, so two live sources can never
        // both drive the camera.
        if (state.aimEvent && event.type !== state.aimEvent)
            return;

        // All three null is the documented way of saying there is no sensor
        // behind this event, so it must not seed the reference pose or claim to
        // be the source.
        if (event.alpha === null && event.beta === null && event.gamma === null)
        {
            state.emptyEvents++;
            state.emptyBy[event.type] = (state.emptyBy[event.type] || 0) + 1;
            return;
        }

        state.aimEvent = event.type;
        state.orientationEvents++;
        state.raw = [event.alpha || 0, event.beta || 0, event.gamma || 0];

        // Where the screen faces, in the room: world x east, y north, z up.
        const facing = basisFrom(event.alpha, event.beta, event.gamma)[2];
        state.facing = facing;

        // Compass bearing and elevation of that direction. Taking the two angles
        // in the room's frame rather than in the handset's own is what keeps
        // them from bleeding into each other: the earlier version measured both
        // against the pose held at switch-on, whose axes only line up with
        // horizontal and vertical if that pose happened to be bolt upright --
        // hold the phone at the usual slouch and tilting it moved the yaw.
        //
        // Both are also blind to roll, which is correct and was not true before:
        // spinning the handset in its own plane does not move where the screen
        // points, so it must not move the camera.
        // Unfolded first, so that both the reference and every reading measured
        // against it live on the same continuous scale.
        const aim = unfold(
            Math.atan2(facing[0], facing[1]),
            Math.asin(clamp(facing[2], -1, 1)));

        // Only the change since switch-on is wanted, so no compass calibration
        // and no assumption about which way the user is facing.
        state.reference ??= { azimuth: aim.azimuth, elevation: aim.elevation };

        state.yaw = wrap(aim.azimuth - state.reference.azimuth);

        // Not wrapped, unlike the yaw: this one is allowed to run past a
        // quarter turn, and the game clamps it to its own pitch limit. Folding
        // it back into a half-open range here would reintroduce the seam that
        // unfold() just removed.
        state.pitch = aim.elevation - state.reference.elevation;

        // Pushed at sensor rate, unlike the readout: this is what the cut is
        // built from, and at ten hertz the box would visibly step.
        // Caught and shown rather than left to throw. A hand-off that fails
        // every reading -- a stale copy of this file against a newer assembly is
        // the way that happens -- otherwise presents as the box simply not
        // moving, which is indistinguishable from a sensor that never reported.
        // The panel above would say "aim 900 events" and give no hint that all
        // 900 were rejected on arrival.
        if (window.theInstance)
        {
            try
            {
                window.theInstance.invokeMethod('SetMotion', state.yaw, state.pitch);
                state.handoffError = '';
            }
            catch (e)
            {
                state.handoffError = e.message || String(e);
            }
        }
    }

    function decay(halfLife, dt)
    {
        return Math.pow(0.5, dt / halfLife);
    }

    /// Integrates acceleration into how far the hand has moved along each of the
    /// phone's own axes. Only the third is used; the rest is for the readout.
    function onMotion(event)
    {
        if (!state.enabled)
            return;

        const now = performance.now();
        const dt = state.lastMotion ? Math.min((now - state.lastMotion) / 1000, 0.1) : 0;
        state.lastMotion = now;

        if (dt <= 0)
            return;

        const linear = event.acceleration;
        let sample;

        if (linear && linear.z !== null && linear.z !== undefined)
        {
            sample = [linear.x || 0, linear.y || 0, linear.z || 0];
            state.source = 'linear';
        }
        else
        {
            // Some Android builds only ever populate the with-gravity reading. A
            // slow low-pass over it is which way is down, and what is left after
            // subtracting that is the push.
            const raw = event.accelerationIncludingGravity;
            if (!raw || raw.z === null || raw.z === undefined)
            {
                state.emptyEvents++;
                return;
            }

            const withGravity = [raw.x || 0, raw.y || 0, raw.z || 0];
            state.gravity ??= withGravity.slice();

            for (let i = 0; i < 3; i++)
                state.gravity[i] += (withGravity[i] - state.gravity[i]) * 0.05;

            sample = [
                withGravity[0] - state.gravity[0],
                withGravity[1] - state.gravity[1],
                withGravity[2] - state.gravity[2],
            ];
            state.source = 'gravity-corrected';
        }

        state.motionEvents++;

        for (let i = 0; i < 3; i++)
        {
            const a = Math.abs(sample[i]) < NoiseFloor ? 0 : sample[i];

            state.acceleration[i] = a;
            state.velocity[i] = (state.velocity[i] + a * dt) * decay(VelocityHalfLife, dt);
            state.offset[i] = (state.offset[i] + state.velocity[i] * dt) * decay(OffsetHalfLife, dt);
        }
    }

    /// What the sensors are actually saying, in the units they say it in, and
    /// what the browser let us have in the first place.
    function readout()
    {
        const centimetres = (value) => (value * 100).toFixed(1).padStart(6) + ' cm';
        const degrees = (value) => (value * 180 / Math.PI).toFixed(0).padStart(4) + ' deg';

        const lines = [
            `events  aim ${state.orientationEvents}  push ${state.motionEvents}`
                + (state.emptyEvents ? `  empty ${state.emptyEvents}` : ''),
            `granted aim ${state.permission.orientation}  push ${state.permission.motion}`,
        ];

        // Kept whether or not motion is currently running, since it costs a
        // button press to obtain.
        if (state.xrProbe)
            lines.push('', state.xrProbe);

        // Above everything else: readings that are arriving and being thrown
        // out is a different fault from readings that never come, and the rest
        // of the panel looks perfectly healthy in the first case.
        if (state.handoffError)
            lines.push('', 'readings rejected by the app:', state.handoffError,
                       '(usually a stale motion.js -- reload)');

        if (!state.orientationEvents)
        {
            lines.push('', 'no aim readings yet.');

            // Named per listener, because which one went quiet says which
            // sensor is missing -- and the two have different answers.
            const relative = state.emptyBy['deviceorientation'] || 0;
            const absolute = state.emptyBy['deviceorientationabsolute'] || 0;

            if (relative && !absolute)
            {
                lines.push('the gyroscope-based event answered with nothing in it,',
                           'and the compass-based one has not answered at all.');
            }
            else if (state.emptyEvents)
            {
                lines.push('both events answer with nothing in them.',
                           'on Chrome, check Settings -> Site settings ->',
                           'Motion sensors is allowed.');
            }
            else
            {
                lines.push('this browser is not firing either event at all.');
            }

            lines.push(`empty  relative ${relative}  absolute ${absolute}`);
        }
        else
        {
            const fixed = (value) => value.toFixed(1).padStart(6);

            // Both in screen axes, so "across" and "up" mean what they say
            // whichever way round the handset is being held.
            const push = screenAxes(state.offset);
            const accel = screenAxes(state.acceleration);

            lines.push(
                `aim     yaw ${degrees(state.yaw)}   pitch ${degrees(state.pitch)}`,
                `raw abg ${state.raw.map(fixed).join(' ')}`,
                `facing  ${state.facing.map(v => v.toFixed(2).padStart(6)).join(' ')} (e n up)`,
                `screen  ${(screenAngle() * 180 / Math.PI).toFixed(0)} deg turned in the hand`,
                // Which listener won. Two engines source these differently, so
                // "it works on my phone" is not portable evidence without it.
                `via     ${state.aimEvent}`,
                // Visible because a wrong flip and a sensor fault look the same
                // from the outside -- the box turns half round either way. If
                // this toggles while the handset is nowhere near flat, the
                // detection in unfold() is firing when it should not.
                `tipped  ${state.flipped ? 'yes, past vertical' : 'no'}`,
                // The third label used to read "(in)", for a figure that is
                // positive when the handset comes *toward* you -- so the panel
                // agreed with the reversed blade and neither one gave the other
                // away. Named for the direction it actually measures now.
                `push    x ${centimetres(push[0])}  (across)`,
                `        y ${centimetres(push[1])}  (up)`,
                `        z ${centimetres(push[2])}  (toward you)`,
                `accel   ${accel.map(a => a.toFixed(2).padStart(6)).join(' ')} m/s2`,
                `source  ${state.source || 'no acceleration yet'}`);
        }

        return lines.join('\n');
    }

    function tell(on, note)
    {
        if (window.theInstance)
            window.theInstance.invokeMethodAsync('SetMotionEnabled', on, note || '');
    }

    function pushReadout(text)
    {
        if (window.theInstance)
            window.theInstance.invokeMethodAsync('SetMotionReadout', text);
    }

    /// iOS 13+ gates both sensors behind a prompt that only opens from a live
    /// user gesture; everywhere else the request function simply does not exist
    /// and the listeners work unasked.
    ///
    /// Both requests are started before either is awaited. Awaiting the first
    /// and then asking for the second spends the gesture on the first prompt,
    /// and the second is refused without ever being shown -- which is exactly
    /// the "no prompt appeared" failure, one sensor further along.
    function requestPermission(constructor)
    {
        if (!constructor)
            return Promise.resolve('no such event');

        if (typeof constructor.requestPermission !== 'function')
            return Promise.resolve('granted');

        try
        {
            return constructor.requestPermission().catch(e => 'blocked: ' + e.message);
        }
        catch (e)
        {
            return Promise.resolve('blocked: ' + e.message);
        }
    }

    function stop(note)
    {
        window.removeEventListener('deviceorientation', onOrientation);
        window.removeEventListener('deviceorientationabsolute', onOrientation);
        window.removeEventListener('devicemotion', onMotion);
        clearInterval(state.timer);

        state.enabled = false;
        state.reference = null;
        state.flipped = false;
        state.lastAzimuth = null;
        state.unfolded = null;
        state.raw = [0, 0, 0];
        state.facing = [0, 0, 1];
        state.gravity = null;
        state.velocity = [0, 0, 0];
        state.offset = [0, 0, 0];
        state.acceleration = [0, 0, 0];
        state.lastMotion = 0;
        state.source = '';
        state.orientationEvents = 0;
        state.motionEvents = 0;
        state.emptyEvents = 0;
        state.permission = { orientation: '-', motion: '-' };
        state.handoffError = '';
        state.aimEvent = '';
        state.emptyBy = {};

        tell(false, note);
        pushReadout('');
    }

    /// The push half of "recentre": forget the travel accumulated so far and
    /// call where the handset is now the resting pose.
    ///
    /// Needed because OffsetHalfLife no longer springs this back on its own.
    /// The aim half lives in Game1.RecentreMotion, which re-anchors the camera;
    /// the button drives both, so one press means "here is home" for the whole
    /// control rather than for half of it.
    ///
    /// The aim reference is deliberately left alone. Game1 re-anchors against
    /// whatever bearing arrives next, so zeroing it here as well would apply the
    /// same correction twice.
    window.recentreMotionJS = () =>
    {
        state.velocity = [0, 0, 0];
        state.offset = [0, 0, 0];

        if (state.enabled)
            pushReadout(readout());
    };

    window.toggleMotionJS = async () =>
    {
        if (state.enabled)
        {
            stop('');
            return;
        }

        if (!window.isSecureContext)
        {
            tell(false, 'motion sensors need https -- this page is not a secure context');
            return;
        }

        if (!window.DeviceOrientationEvent && !window.DeviceMotionEvent)
        {
            tell(false, 'this browser has no motion sensor API at all');
            return;
        }

        // Started here, alongside the permission requests and awaited with them,
        // for exactly the reason they are started together: this function is
        // running inside a real user gesture, and awaiting anything spends it.
        //
        // Asked from a gesture at all because the same question answered cold,
        // from the diagnostics panel, came back false on a handset whose site
        // permissions list AR. If the two answers differ, the capability is
        // gated on activation and Tier 3 is not ruled out; if they agree, the
        // device genuinely cannot do it. Either way the answer is only worth
        // having next to the one taken the other way.
        const pending = [
            requestPermission(window.DeviceOrientationEvent),
            requestPermission(window.DeviceMotionEvent),
            window.xrReport ? window.xrReport('from the motion button')
                            : Promise.resolve(''),
        ];

        const [orientation, motion, xr] = await Promise.all(pending);
        state.permission = { orientation, motion };
        state.xrProbe = xr;

        // Aiming is the half that cannot be done without: a blade that can be
        // pushed but not aimed is no better than the space bar.
        if (orientation !== 'granted')
        {
            tell(false, 'orientation permission: ' + orientation);
            return;
        }

        state.enabled = true;
        // Both names, because the two engines disagree about which one carries
        // what, and the disagreement is not cosmetic.
        //
        // Chromium backs `deviceorientation` with the *relative* orientation
        // sensor, which is fused from the gyroscope. On a handset without one --
        // or with one the platform will not start -- it has nothing to report,
        // so it fires a single event with all three fields null and then goes
        // quiet. `deviceorientationabsolute` is backed by the absolute sensor,
        // fused from the accelerometer and magnetometer, and needs no gyroscope.
        // Firefox has no such split: its `deviceorientation` is already the
        // absolute one, which is why the same device works there and not here.
        //
        // Listening for both costs nothing when both work, since the first to
        // deliver real data claims the role and the other is dropped.
        window.addEventListener('deviceorientation', onOrientation);
        window.addEventListener('deviceorientationabsolute', onOrientation);
        window.addEventListener('devicemotion', onMotion);

        tell(true, motion === 'granted' ? '' : 'no push sensor: ' + motion);

        // Left running whatever arrives, rather than switching itself off when
        // nothing does: the panel is the only way to see which sensor is silent,
        // and a feature that turns itself off takes its own diagnosis with it.
        state.timer = setInterval(() => pushReadout(readout()), ReadoutInterval);
        pushReadout(readout());
    };
})();
