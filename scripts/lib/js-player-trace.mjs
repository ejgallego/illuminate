/**
 * The production JavaScript player's state machine, exposed as a deterministic trace oracle.
 *
 * The helper object is normally `globalThis` after loading `anim_core.js`. Tests may instead
 * supply a VM context containing those functions.
 */
export class LegacyPlayerOracle {
    constructor(data, helpers = globalThis) {
        this.data = data;
        this.helpers = helpers;
        this.frame = 0;
        this.currentStep = 0;
        this.startTime = null;
        this.pauseFrame = 0;
        this.playing = false;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.currentSegment = -1;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    playback() {
        if (this.waitingForClick) return "waiting";
        if (this.finished) return "finished";
        if (!this.playing) return "paused";
        if (this.advancePending) return "finishingLoop";
        if (this.targetFrame !== null) return "playing";
        if (this.data.steps[this.currentStep]?.loop) return "looping";
        return "playing";
    }

    action() {
        this.frame = this.helpers.animClampFrame(this.frame, this.data.totalFrames);
        const segmentValue = this.helpers.animFindSegment(this.data.segments, this.frame);
        const segment = this.data.segments.indexOf(segmentValue);
        const localFrame = this.frame - segmentValue.sf;
        const segmentChanged = segment !== this.currentSegment;
        this.currentSegment = segment;
        const values = segmentValue.params[localFrame] ?? [];
        const updates = segmentValue.pmap.flatMap((binding, index) =>
            values[index] === undefined ? [] : [{ e: binding.e, a: binding.a, v: values[index] }],
        );
        return {
            frame: this.frame,
            step: this.currentStep,
            segment,
            localFrame,
            segmentChanged,
            updates,
            playback: this.playback(),
        };
    }

    advance() {
        if (this.waitingForClick) {
            this.waitingForClick = false;
            this.startTime = null;
            this.playing = true;
            this.finished = false;
            this.targetFrame = null;
            this.loopAfterTarget = false;
            return;
        }
        if (this.playing) {
            const step = this.data.steps[this.currentStep];
            if (step?.loop && this.currentStep + 1 < this.data.steps.length) {
                this.advancePending = true;
            } else {
                this.playing = false;
                this.pauseFrame = this.frame;
                this.targetFrame = null;
                this.loopAfterTarget = false;
            }
            return;
        }
        if (this.pauseFrame >= this.data.totalFrames - 1) {
            this.pauseFrame = 0;
            this.currentStep = 0;
            this.frame = 0;
        }
        this.playing = true;
        this.startTime = null;
        this.finished = false;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    pause() {
        this.startTime = null;
        this.pauseFrame = this.frame;
        this.playing = false;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    seek(requested) {
        this.playing = false;
        this.waitingForClick = false;
        this.advancePending = false;
        this.frame = this.helpers.animClampFrame(requested, this.data.totalFrames);
        this.pauseFrame = this.frame;
        this.currentStep = this.helpers.animFindCurrentStep(this.data.steps, this.frame);
        this.finished = this.frame === this.data.totalFrames - 1;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    loopAt(requested) {
        const frame = this.helpers.animClampFrame(requested, this.data.totalFrames);
        const step = this.helpers.animFindCurrentStep(this.data.steps, frame);
        const stepInfo = this.data.steps[step];
        if (!stepInfo?.loop) {
            this.seek(frame);
            return;
        }
        this.frame = stepInfo.frame;
        this.currentStep = step;
        this.startTime = null;
        this.pauseFrame = stepInfo.frame;
        this.playing = true;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    playTo(requested, loopAfter) {
        const target = this.helpers.animClampFrame(requested, this.data.totalFrames);
        if (target === this.frame) {
            if (loopAfter) this.loopAt(target);
            else this.pause();
            return;
        }
        this.currentStep = this.helpers.animFindCurrentStep(this.data.steps, this.frame);
        this.startTime = null;
        this.pauseFrame = this.frame;
        this.playing = true;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.targetFrame = target;
        this.loopAfterTarget = loopAfter;
    }

    tick(timestamp) {
        if (!this.playing || this.waitingForClick) return;
        if (this.targetFrame !== null) {
            if (this.startTime === null) this.startTime = timestamp;
            const elapsed = this.helpers.animComputeFrame(
                this.startTime,
                timestamp,
                this.data.fps,
                0,
            );
            const target = this.targetFrame;
            const forward = target >= this.pauseFrame;
            this.frame = forward
                ? Math.min(target, this.pauseFrame + elapsed)
                : this.pauseFrame - Math.min(elapsed, this.pauseFrame - target);
            this.currentStep = this.helpers.animFindCurrentStep(this.data.steps, this.frame);
            if (this.frame === target) {
                const loopAfter = this.loopAfterTarget;
                this.startTime = null;
                this.pauseFrame = this.frame;
                this.playing = false;
                this.targetFrame = null;
                this.loopAfterTarget = false;
                if (loopAfter) this.loopAt(this.frame);
            }
            return;
        }
        if (this.startTime === null) this.startTime = timestamp;
        let frame = this.helpers.animComputeFrame(
            this.startTime,
            timestamp,
            this.data.fps,
            this.pauseFrame,
        );
        const stepInfo = this.data.steps[this.currentStep];
        let isLooping = Boolean(stepInfo?.loop);
        if (isLooping) {
            const stepStart = stepInfo.frame;
            const stepEnd = this.helpers.animFindStepEnd(
                this.data.steps,
                this.currentStep,
                this.data.totalFrames,
            );
            const loop = this.helpers.animWrapLoop(frame, stepStart, stepEnd);
            if (loop.didCycle) {
                if (this.advancePending) {
                    this.advancePending = false;
                    if (this.currentStep + 1 < this.data.steps.length) {
                        this.currentStep += 1;
                        frame = this.data.steps[this.currentStep].frame;
                        this.pauseFrame = frame;
                        this.startTime = null;
                        isLooping = false;
                    }
                } else {
                    frame = loop.wrapped;
                    this.startTime = timestamp;
                    this.pauseFrame = stepStart;
                }
            }
        }
        if (frame >= this.data.totalFrames) {
            frame = this.data.totalFrames - 1;
            this.pauseFrame = frame;
            this.playing = false;
            this.finished = true;
        }
        if (!isLooping) {
            const pause = this.helpers.animCheckPauseSteps(
                this.data.steps,
                this.currentStep,
                frame,
            );
            if (pause !== null) {
                frame = pause.pauseAtFrame;
                this.pauseFrame = frame;
                this.waitingForClick = true;
                this.currentStep = pause.pauseAtStep;
                this.frame = frame;
                return;
            }
            this.currentStep = this.helpers.animFindCurrentStep(this.data.steps, frame);
        }
        this.frame = frame;
    }

    dispatch(event) {
        if (event.kind === "advance") this.advance();
        else if (event.kind === "pause") this.pause();
        else if (event.kind === "seek") this.seek(event.frame);
        else if (event.kind === "playTo") this.playTo(event.frame, event.loopAfter);
        else if (event.kind === "loopAt") this.loopAt(event.frame);
        else if (event.kind === "tick") this.tick(event.timestamp);
        else throw new Error(`unknown oracle event: ${event.kind}`);
        return this.action();
    }
}

/** Replays an event sequence through the production JavaScript state machine. */
export function replayLegacyPlayerTrace(data, events, helpers = globalThis) {
    const oracle = new LegacyPlayerOracle(data, helpers);
    return {
        ok: true,
        actions: [oracle.action(), ...events.map((event) => oracle.dispatch(event))],
    };
}
