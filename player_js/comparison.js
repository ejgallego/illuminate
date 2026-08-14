// @ts-check

/**
 * @typedef {{
 *   title: string,
 *   data: AnimData
 * }} ComparisonExample
 * @typedef {{
 *   call(name: string, ...args: unknown[]): unknown,
 *   callTimed(name: string, ...args: unknown[]): { value: unknown, timings: RuntimeCallTimings },
 *   setCallbackTimingObserver(observer: ((timings: RuntimeCallTimings) => void) | null): void,
 *   dispose(): void
 * }} ComparisonVirRuntime
 * @typedef {{ time: number, duration: number }} CallbackSample
 * @typedef {{
 *   marshalMs: number,
 *   executeMs: number,
 *   decodeMs: number,
 *   hostMs: number,
 *   totalMs: number
 * }} RuntimeCallTimings
 * @typedef {"paused" | "playing" | "waiting" | "looping" | "finishingLoop" | "finished"} ComparisonPlaybackStatus
 * @typedef {{ frame: number, step: number, segment: number, localFrame: number, segmentChanged: boolean, playback: ComparisonPlaybackStatus }} ComparisonFrameSelection
 * @typedef {RuntimeCallTimings & {
 *   time: number,
 *   rewindMs: number,
 *   scratchBytes: number
 * }} RuntimePhaseSample
 * @typedef {{ totalMs: number, projectMs: number, encodeMs: number, persistentBytes: number }} CreationSample
 * @typedef {{
 *   samples: number,
 *   marshalMs: number,
 *   executeMs: number,
 *   decodeMs: number,
 *   rewindMs: number,
 *   hostMs: number,
 *   adapterMs: number
 * }} PhaseAggregate
 * @typedef {{
 *   fps: number,
 *   cpu: number,
 *   mean: number,
 *   active: number,
 *   phases: PhaseAggregate,
 *   maximum: number,
 *   maximumAt: number | null,
 *   maximumCallback: number | null,
 *   slowCallbacks: number,
 *   peakTitle: string
 * }} DashboardEngineTotals
 * @typedef {(timings: RuntimeCallTimings) => void} JsSelectionObserver
 * @typedef {{
 *   owner: string,
 *   engine: "js" | "vir" | "fir",
 *   samples: CallbackSample[],
 *   phaseSamples: RuntimePhaseSample[],
 *   creation: CreationSample | null,
 *   totalCallbacks: number,
 *   totalCpu: number,
 *   maximumCallbackMs: number,
 *   maximumCallbackAt: number | null,
 *   maximumCallbackNumber: number | null,
 *   totalSlowCallbacks: number
 * }} PlayerMetrics
 * @typedef {{
 *   createPlayer(animation: AnimData): unknown,
 *   dispatch(player: unknown, event: unknown): unknown,
 *   dispatchTick(player: unknown, timestamp: number): unknown,
 *   disposePlayer(player: unknown): void
 * }} ComparisonFirAdapter
 * @typedef {{
 *   kind: "create" | "dispatch",
 *   operation: string,
 *   adapterTimings: Record<string, number> | null,
 *   memory: Record<string, number | string | undefined> | null,
 *   adapterWallMs: number,
 *   renderMs: number,
 *   totalMs: number
 * }} ComparisonFirObservation
 * @typedef {{
 *   kind: "create" | "dispatch",
 *   operation: string,
 *   runtimeTimings: Record<string, number> | null,
 *   runtimeWallMs: number,
 *   projectMs: number,
 *   renderMs: number,
 *   totalMs: number
 * }} ComparisonVirSelectionObservation
 * @typedef {{
 *   frame: number,
 *   step: number,
 *   playback: string
 * }} LegacySnapshot
 * @typedef {{
 *   advance(): void,
 *   pause(): void,
 *   seek(frame: number): void,
 *   snapshot(): LegacySnapshot,
 *   dispose(): void
 * }} LegacyPlayer
 * @typedef {{
 *   advance(): void,
 *   pause(): void,
 *   seek(frame: number): void,
 *   dispose(): void
 * }} ComparisonCandidate
 * @typedef {{
 *   index: number,
 *   data: AnimData,
 *   legacy: LegacyPlayer,
 *   candidate: ComparisonCandidate,
 *   jsOwner: string,
 *   candidateOwner: string,
 *   candidateFirst: boolean,
 *   waitingSince: number | null,
 *   loopSince: number | null,
 *   finishedSince: number | null
 * }} ComparisonRow
 */

(async function () {
    /** @type {ComparisonExample[]} */
    var examples = __ILLUMINATE_COMPARISON_DATA_98712__;
    var runtimeUrl = "__ILLUMINATE_COMPARISON_RUNTIME_98712__";
    var wasmUrl = "__ILLUMINATE_COMPARISON_WASM_98712__";
    var packageSetUrl = "__ILLUMINATE_COMPARISON_PACKAGE_SET_98712__";
    var firAdapterUrl = "./fir-live/illuminate-selection-player-browser-adapter.mjs";
    var firWasmUrl = "./fir-live/illuminate-selection-player.wasm";
    var firManifestUrl = "./fir-live/illuminate-selection-player.wasm.json";
    var firBuildUrl = "./fir-live/BUILD.json";
    var sampleWindowMs = 2000;
    var metrics = new Map();
    var labParams = new URLSearchParams(window.location.search);
    /** @type {"playback" | "analysis"} */
    var currentView = labParams.get("view") === "analysis" ? "analysis" : "playback";
    /** @type {"selected" | "all"} */
    var currentScope = labParams.get("scope") === "all" ? "all" : "selected";
    /** @type {string | null} */
    var currentOwner = null;
    /** @type {HTMLInputElement | null} */
    var phaseTiming = null;
    var nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    var nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);

    function detailedChartsEnabled() {
        return (
            Boolean(phaseTiming?.checked) && document.body.dataset.suppressPhaseCharts !== "true"
        );
    }

    /** @param {string} owner @param {"js" | "vir" | "fir"} engine */
    function registerMetrics(owner, engine) {
        /** @type {PlayerMetrics} */
        var value = {
            owner: owner,
            engine: engine,
            samples: [],
            phaseSamples: [],
            creation: null,
            totalCallbacks: 0,
            totalCpu: 0,
            maximumCallbackMs: 0,
            maximumCallbackAt: null,
            maximumCallbackNumber: null,
            totalSlowCallbacks: 0,
        };
        metrics.set(owner, value);
    }

    /** @param {PlayerMetrics} value */
    function clearPersistentMetrics(value) {
        value.maximumCallbackMs = 0;
        value.maximumCallbackAt = null;
        value.maximumCallbackNumber = null;
        value.totalSlowCallbacks = 0;
    }

    /** @param {PlayerMetrics} value */
    function clearRunMetrics(value) {
        value.samples.length = 0;
        value.phaseSamples.length = 0;
        value.totalCallbacks = 0;
        value.totalCpu = 0;
        clearPersistentMetrics(value);
    }

    /** @template T @param {string} owner @param {() => T} action @returns {T} */
    function withOwner(owner, action) {
        var previous = currentOwner;
        currentOwner = owner;
        try {
            return action();
        } finally {
            currentOwner = previous;
        }
    }

    /** @param {PlayerMetrics} value @param {number} now */
    function pruneSamples(value, now) {
        var cutoff = now - sampleWindowMs;
        while (value.samples.length > 0 && value.samples[0].time < cutoff) {
            value.samples.shift();
        }
        while (value.phaseSamples.length > 0 && value.phaseSamples[0].time < cutoff) {
            value.phaseSamples.shift();
        }
    }

    /** @param {RuntimeCallTimings} timings */
    function recordVirCallbackTiming(timings) {
        if (currentOwner === null) return;
        var value = metrics.get(currentOwner);
        if (!value || value.engine !== "vir") return;
        var now = performance.now();
        value.phaseSamples.push({
            time: now,
            marshalMs: timings.marshalMs,
            executeMs: timings.executeMs,
            decodeMs: timings.decodeMs,
            hostMs: timings.hostMs,
            totalMs: timings.totalMs,
            rewindMs: 0,
            scratchBytes: 0,
        });
        pruneSamples(value, now);
    }

    /** @param {RuntimeCallTimings} timings */
    function recordJsSelectionTiming(timings) {
        if (currentOwner === null) return;
        var value = metrics.get(currentOwner);
        if (!value || value.engine !== "js") return;
        var now = performance.now();
        value.phaseSamples.push({
            time: now,
            marshalMs: 0,
            executeMs: timings.executeMs,
            decodeMs: 0,
            hostMs: timings.hostMs,
            totalMs: timings.totalMs,
            rewindMs: 0,
            scratchBytes: 0,
        });
        pruneSamples(value, now);
    }

    /** @param {ComparisonFirObservation} observation */
    function recordFirObservation(observation) {
        if (currentOwner === null) return;
        var value = metrics.get(currentOwner);
        if (!value || value.engine !== "fir") return;
        var timings = observation.adapterTimings;
        var memory = observation.memory;
        if (observation.kind === "create") {
            value.creation = {
                totalMs: timings?.totalMs ?? observation.adapterWallMs,
                projectMs: timings?.projectMs ?? 0,
                encodeMs: timings?.selectionEncodeMs ?? timings?.animationEncodeMs ?? 0,
                persistentBytes: Math.max(
                    0,
                    Number(memory?.persistentCheckpoint ?? 0) - Number(memory?.frontierBefore ?? 0),
                ),
            };
            return;
        }
        if (observation.operation !== "tick" || !phaseTiming?.checked) return;
        var now = performance.now();
        var runtimeTotal = timings?.totalMs ?? observation.adapterWallMs;
        value.phaseSamples.push({
            time: now,
            marshalMs: timings?.encodeMs ?? 0,
            executeMs: timings?.executeMs ?? 0,
            decodeMs: timings?.decodeMs ?? 0,
            rewindMs: timings?.rewindMs ?? 0,
            hostMs: observation.renderMs,
            totalMs: runtimeTotal + observation.renderMs,
            scratchBytes: Number(memory?.scratchBytes ?? 0),
        });
        pruneSamples(value, now);
    }

    /** @param {ComparisonVirSelectionObservation} observation */
    function recordVirSelectionObservation(observation) {
        if (currentOwner === null) return;
        var value = metrics.get(currentOwner);
        if (!value || value.engine !== "vir") return;
        var timings = observation.runtimeTimings;
        if (observation.kind === "create") {
            value.creation = {
                totalMs: observation.runtimeWallMs,
                projectMs: observation.projectMs,
                encodeMs: timings?.marshalMs ?? 0,
                persistentBytes: 0,
            };
            return;
        }
        if (observation.operation !== "tick" || !phaseTiming?.checked) return;
        var now = performance.now();
        var runtimeTotal = timings?.totalMs ?? observation.runtimeWallMs;
        value.phaseSamples.push({
            time: now,
            marshalMs: timings?.marshalMs ?? 0,
            executeMs: timings?.executeMs ?? 0,
            decodeMs: timings?.decodeMs ?? 0,
            rewindMs: 0,
            hostMs: observation.renderMs,
            totalMs: runtimeTotal + observation.renderMs,
            scratchBytes: 0,
        });
        pruneSamples(value, now);
    }

    window.requestAnimationFrame = function (callback) {
        var owner = currentOwner;
        if (owner === null || !metrics.has(owner)) {
            return nativeRequestAnimationFrame(callback);
        }
        var capturedOwner = owner;
        return nativeRequestAnimationFrame(function (timestamp) {
            var started = performance.now();
            try {
                withOwner(capturedOwner, function () {
                    callback(timestamp);
                });
            } finally {
                var finished = performance.now();
                var value = metrics.get(capturedOwner);
                if (value) {
                    var duration = finished - started;
                    value.samples.push({ time: finished, duration: duration });
                    value.totalCallbacks += 1;
                    value.totalCpu += duration;
                    if (duration > value.maximumCallbackMs) {
                        value.maximumCallbackMs = duration;
                        value.maximumCallbackAt = finished;
                        value.maximumCallbackNumber = value.totalCallbacks;
                    }
                    if (duration > 16.7) value.totalSlowCallbacks += 1;
                    pruneSamples(value, finished);
                }
            }
        });
    };
    window.cancelAnimationFrame = function (handle) {
        nativeCancelAnimationFrame(handle);
    };

    /**
     * @param {AnimData} data
     * @param {HTMLElement} container
     * @param {JsSelectionObserver | null} observer
     * @param {(() => boolean) | null} observeTick
     * @returns {LegacyPlayer}
     */
    function mountLegacy(data, container, observer = null, observeTick = null) {
        var currentSegment = -1;
        var renderer = createSelectionDomRenderer(data, container);
        var playing = false;
        /** @type {number | null} */
        var startTime = null;
        var pauseFrame = 0;
        var currentFrame = 0;
        var currentStep = 0;
        var waitingForClick = false;
        var advancePending = false;
        /** @type {number | null} */
        var pendingFrame = null;
        var disposed = false;

        /** @returns {ComparisonPlaybackStatus} */
        function playbackStatus() {
            if (waitingForClick) return "waiting";
            if (playing && advancePending) return "finishingLoop";
            if (playing && data.steps[currentStep]?.loop) return "looping";
            if (playing) return "playing";
            if (currentFrame >= data.totalFrames - 1) return "finished";
            return "paused";
        }

        /** @param {number} frame @param {number | null} tickStarted */
        function showFrame(frame, tickStarted = null) {
            frame = animClampFrame(frame, data.totalFrames);
            var segment = animFindSegment(data.segments, frame);
            var segmentIndex = data.segments.indexOf(segment);
            if (segmentIndex < 0) throw new Error("JavaScript selected an unknown segment");
            currentFrame = frame;
            /** @type {ComparisonFrameSelection} */
            var selection = {
                frame: frame,
                step: currentStep,
                segment: segmentIndex,
                localFrame: frame - segment.sf,
                segmentChanged: segmentIndex !== currentSegment,
                playback: playbackStatus(),
            };
            var selectionReady = tickStarted === null ? 0 : performance.now();
            renderer.render(selection);
            if (tickStarted !== null) {
                var rendered = performance.now();
                observer?.({
                    marshalMs: 0,
                    executeMs: selectionReady - tickStarted,
                    decodeMs: 0,
                    hostMs: rendered - selectionReady,
                    totalMs: rendered - tickStarted,
                });
            }
            currentSegment = segmentIndex;
        }

        function cancelPending() {
            if (pendingFrame !== null) {
                cancelAnimationFrame(pendingFrame);
                pendingFrame = null;
            }
        }

        function schedule() {
            if (!disposed && playing && !waitingForClick && pendingFrame === null) {
                pendingFrame = requestAnimationFrame(tick);
            }
        }

        /** @param {number} timestamp */
        function tick(timestamp) {
            pendingFrame = null;
            if (disposed || !playing || waitingForClick) return;
            var tickStarted =
                observer !== null && (observeTick?.() ?? true) ? performance.now() : null;
            if (startTime === null) startTime = timestamp;
            var frame = animComputeFrame(startTime, timestamp, data.fps, pauseFrame);
            var stepInfo = data.steps[currentStep];
            var isLooping = Boolean(stepInfo && stepInfo.loop);
            if (isLooping && stepInfo) {
                var stepStart = stepInfo.frame;
                var stepEnd = animFindStepEnd(data.steps, currentStep, data.totalFrames);
                var loop = animWrapLoop(frame, stepStart, stepEnd);
                if (loop.didCycle) {
                    if (advancePending && currentStep + 1 < data.steps.length) {
                        advancePending = false;
                        currentStep += 1;
                        var nextFrame = data.steps[currentStep].frame;
                        pauseFrame = nextFrame;
                        startTime = null;
                        frame = nextFrame;
                        isLooping = false;
                    } else {
                        frame = loop.wrapped;
                        startTime = timestamp;
                        pauseFrame = stepStart;
                    }
                }
            }
            if (frame >= data.totalFrames) {
                frame = data.totalFrames - 1;
                pauseFrame = frame;
                playing = false;
            }
            if (!isLooping) {
                var pause = animCheckPauseSteps(data.steps, currentStep, frame);
                if (pause) {
                    frame = pause.pauseAtFrame;
                    pauseFrame = frame;
                    waitingForClick = true;
                    currentStep = pause.pauseAtStep;
                    showFrame(frame, tickStarted);
                    return;
                }
                currentStep = animFindCurrentStep(data.steps, frame);
            }
            showFrame(frame, tickStarted);
            schedule();
        }

        function advance() {
            if (disposed) return;
            if (waitingForClick) {
                waitingForClick = false;
                startTime = null;
                playing = true;
                schedule();
            } else if (playing) {
                var stepInfo = data.steps[currentStep];
                if (stepInfo && stepInfo.loop && currentStep + 1 < data.steps.length) {
                    advancePending = true;
                } else {
                    playing = false;
                    pauseFrame = currentFrame;
                    startTime = null;
                    advancePending = false;
                    cancelPending();
                }
            } else {
                if (pauseFrame >= data.totalFrames - 1) {
                    pauseFrame = 0;
                    currentStep = 0;
                    showFrame(0);
                }
                playing = true;
                startTime = null;
                schedule();
            }
        }

        function pause() {
            playing = false;
            waitingForClick = false;
            advancePending = false;
            pauseFrame = currentFrame;
            startTime = null;
            cancelPending();
        }

        /** @param {number} frame */
        function seek(frame) {
            pause();
            pauseFrame = animClampFrame(frame, data.totalFrames);
            currentStep = animFindCurrentStep(data.steps, pauseFrame);
            showFrame(pauseFrame);
        }

        /** @returns {LegacySnapshot} */
        function snapshot() {
            /** @type {string} */
            var playback = playbackStatus();
            if (playback === "finishingLoop") playback = "finishing loop";
            return { frame: currentFrame, step: currentStep, playback: playback };
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            cancelPending();
            renderer.dispose?.();
        }

        showFrame(0);
        return {
            advance: advance,
            pause: pause,
            seek: seek,
            snapshot: snapshot,
            dispose: dispose,
        };
    }

    /** @param {number} value @param {number} digits */
    function formatNumber(value, digits) {
        return Number.isFinite(value) ? value.toFixed(digits) : "0";
    }

    /** @param {number} value */
    function formatBytes(value) {
        if (!Number.isFinite(value) || value <= 0) return "0 B";
        if (value < 1024) return formatNumber(value, 0) + " B";
        return formatNumber(value / 1024, 1) + " KiB";
    }

    /** @param {number} value */
    function formatDuration(value) {
        if (!Number.isFinite(value) || value <= 0) return "—";
        if (value < 1) {
            return formatNumber(value * 1000, value < 0.01 ? 1 : 0) + " µs";
        }
        return formatNumber(value, value < 10 ? 2 : 1) + " ms";
    }

    /** @param {PlayerMetrics} value @param {number} now */
    function metricSnapshot(value, now) {
        pruneSamples(value, now);
        var durations = value.samples.map(function (sample) {
            return sample.duration;
        });
        var elapsed = sampleWindowMs / 1000;
        var cpu = durations.reduce(function (sum, duration) {
            return sum + duration;
        }, 0);
        var sorted = durations.slice().sort(function (left, right) {
            return left - right;
        });
        var p95 = sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) * 0.95)];
        var rollingMaximum = sorted.length === 0 ? 0 : sorted[sorted.length - 1];
        var rollingSlowCallbacks = durations.filter(function (duration) {
            return duration > 16.7;
        }).length;
        return {
            fps: durations.length / elapsed,
            cpuPercent: (cpu / sampleWindowMs) * 100,
            mean: durations.length === 0 ? 0 : cpu / durations.length,
            p95: p95,
            maximum: value.maximumCallbackMs,
            maximumAt: value.maximumCallbackAt,
            maximumCallback: value.maximumCallbackNumber,
            rollingMaximum: rollingMaximum,
            longFrames: value.totalSlowCallbacks,
            rollingSlowCallbacks: rollingSlowCallbacks,
            totalCallbacks: value.totalCallbacks,
        };
    }

    /** @param {PlayerMetrics} value @param {number} outerMean @param {number} now */
    function phaseSnapshot(value, outerMean, now) {
        pruneSamples(value, now);
        var count = value.phaseSamples.length;
        var totals = value.phaseSamples.reduce(
            function (sum, sample) {
                sum.marshalMs += sample.marshalMs;
                sum.executeMs += sample.executeMs;
                sum.decodeMs += sample.decodeMs;
                sum.rewindMs += sample.rewindMs;
                sum.hostMs += sample.hostMs;
                sum.totalMs += sample.totalMs;
                sum.scratchBytes += sample.scratchBytes;
                return sum;
            },
            {
                marshalMs: 0,
                executeMs: 0,
                decodeMs: 0,
                rewindMs: 0,
                hostMs: 0,
                totalMs: 0,
                scratchBytes: 0,
            },
        );
        var divisor = count === 0 ? 1 : count;
        var totalMs = totals.totalMs / divisor;
        return {
            samples: count,
            marshalMs: totals.marshalMs / divisor,
            executeMs: totals.executeMs / divisor,
            decodeMs: totals.decodeMs / divisor,
            rewindMs: totals.rewindMs / divisor,
            hostMs: totals.hostMs / divisor,
            totalMs: totalMs,
            adapterMs: count === 0 ? 0 : Math.max(0, outerMean - totalMs),
            scratchBytes: totals.scratchBytes / divisor,
            creation: value.creation,
        };
    }

    /** @param {HTMLElement} target @param {ReturnType<typeof metricSnapshot>} snapshot */
    function renderMetric(target, snapshot) {
        /** @param {string} name @param {string} value */
        function setStat(name, value) {
            var node = target.querySelector("[data-stat=" + name + "]");
            if (node) node.textContent = value;
        }
        setStat("fps", formatNumber(snapshot.fps, 1));
        setStat("cpu", formatNumber(snapshot.cpuPercent, 1) + "%");
        setStat("mean", formatDuration(snapshot.mean));
        setStat("p95", formatDuration(snapshot.p95));
        setStat("max", formatDuration(snapshot.maximum));
        setStat("long", String(snapshot.longFrames));
    }

    /**
     * @param {{ maximum: number, maximumAt: number | null, maximumCallback: number | null, slowCallbacks: number, title: string }} jsPeak
     * @param {{ maximum: number, maximumAt: number | null, maximumCallback: number | null, slowCallbacks: number, title: string }} candidatePeak
     * @param {number} now
     */
    function renderPersistentPeaks(jsPeak, candidatePeak, now) {
        for (var pair of [
            ["js", jsPeak],
            ["candidate", candidatePeak],
        ]) {
            var owner = /** @type {"js" | "candidate"} */ (pair[0]);
            var peak = /** @type {typeof jsPeak} */ (pair[1]);
            var value = document.querySelector('[data-sticky-peak="' + owner + '"]');
            var detail = document.querySelector('[data-sticky-peak-detail="' + owner + '"]');
            var formattedPeak = formatDuration(peak.maximum);
            if (value && value.textContent !== formattedPeak) value.textContent = formattedPeak;
            if (detail) {
                var age =
                    peak.maximumAt === null
                        ? "waiting"
                        : formatNumber((now - peak.maximumAt) / 1000, 1) + "s ago";
                var formattedDetail =
                    peak.maximumCallback === null
                        ? "waiting for callbacks"
                        : peak.title + " · #" + String(peak.maximumCallback) + " · " + age;
                if (detail.textContent !== formattedDetail) detail.textContent = formattedDetail;
                var tooltip =
                    peak.title + " · " + String(peak.slowCallbacks) + " callbacks over 16.7 ms";
                if (detail.getAttribute("title") !== tooltip) detail.setAttribute("title", tooltip);
            }
        }
        var ratio = jsPeak.maximum > 0 ? candidatePeak.maximum / jsPeak.maximum : 0;
        var ratioNode = document.querySelector("[data-sticky-peak-ratio]");
        if (ratioNode) {
            var formattedRatio = ratio > 0 ? formatNumber(ratio, 2) + "×" : "—";
            if (ratioNode.textContent !== formattedRatio) ratioNode.textContent = formattedRatio;
        }
    }

    /**
     * @param {HTMLElement} target
     * @param {{ mean: number }} reference
     * @param {{ mean: number }} candidate
     */
    function renderOverheadRatio(target, reference, candidate) {
        var ratio = reference.mean > 0 ? candidate.mean / reference.mean : 0;
        var delta = candidate.mean - reference.mean;
        var value = target.querySelector("[data-overhead-value]");
        var detail = target.querySelector("[data-overhead-detail]");
        var fill = /** @type {HTMLElement | null} */ (target.querySelector("[data-overhead-fill]"));
        if (!Number.isFinite(ratio) || ratio <= 0) {
            if (value) value.textContent = "—";
            if (detail) detail.textContent = "waiting for paired callbacks";
            if (fill) fill.style.width = "0%";
            target.dataset.overheadState = "waiting";
            target.dataset.overheadValue = "";
            return;
        }
        if (value) value.textContent = formatNumber(ratio, 2) + "× JS";
        if (detail) {
            var unit = Math.abs(delta) < 1 ? " μs" : " ms";
            var scaled = Math.abs(delta) < 1 ? delta * 1000 : delta;
            var sign = scaled > 0 ? "+" : "";
            detail.textContent = sign + formatNumber(scaled, Math.abs(scaled) < 10 ? 1 : 0) + unit;
        }
        if (fill) fill.style.width = formatNumber(Math.min(ratio, 10) * 10, 1) + "%";
        target.dataset.overheadState = ratio <= 1 ? "faster" : "slower";
        target.dataset.overheadValue = String(ratio);
    }

    /** @returns {PhaseAggregate} */
    function emptyPhaseAggregate() {
        return {
            samples: 0,
            marshalMs: 0,
            executeMs: 0,
            decodeMs: 0,
            rewindMs: 0,
            hostMs: 0,
            adapterMs: 0,
        };
    }

    /** @param {PhaseAggregate} aggregate @param {ReturnType<typeof phaseSnapshot>} snapshot */
    function addPhaseAggregate(aggregate, snapshot) {
        if (snapshot.samples === 0) return;
        aggregate.samples += 1;
        aggregate.marshalMs += snapshot.marshalMs;
        aggregate.executeMs += snapshot.executeMs;
        aggregate.decodeMs += snapshot.decodeMs;
        aggregate.rewindMs += snapshot.rewindMs;
        aggregate.hostMs += snapshot.hostMs;
        aggregate.adapterMs += snapshot.adapterMs;
    }

    /** @param {PhaseAggregate} aggregate @returns {PhaseAggregate} */
    function averagePhaseAggregate(aggregate) {
        var divisor = aggregate.samples === 0 ? 1 : aggregate.samples;
        return {
            samples: aggregate.samples,
            marshalMs: aggregate.marshalMs / divisor,
            executeMs: aggregate.executeMs / divisor,
            decodeMs: aggregate.decodeMs / divisor,
            rewindMs: aggregate.rewindMs / divisor,
            hostMs: aggregate.hostMs / divisor,
            adapterMs: aggregate.adapterMs / divisor,
        };
    }

    /** @param {number} jsCpu @param {number} candidateCpu */
    function renderAggregateCpu(jsCpu, candidateCpu) {
        var scale = Math.max(jsCpu, candidateCpu, 0.001);
        for (var pair of [
            ["js", jsCpu],
            ["candidate", candidateCpu],
        ]) {
            var owner = String(pair[0]);
            var value = Number(pair[1]);
            var output = document.querySelector('[data-aggregate-cpu-value="' + owner + '"]');
            var fill = /** @type {HTMLElement | null} */ (
                document.querySelector('[data-aggregate-cpu-fill="' + owner + '"]')
            );
            if (output) output.textContent = formatNumber(value, 1) + "%";
            if (fill) fill.style.width = formatNumber((value / scale) * 100, 1) + "%";
        }
    }

    /**
     * @param {PhaseAggregate} jsPhases
     * @param {PhaseAggregate} candidatePhases
     * @param {number} jsCallbackMs
     * @param {number} candidateCallbackMs
     * @param {"vir-selection" | "vir-full" | "fir"} engine
     */
    function pairedPhaseDefinitions(
        jsPhases,
        candidatePhases,
        jsCallbackMs,
        candidateCallbackMs,
        engine,
    ) {
        return [
            {
                key: "callback",
                label: "whole callback",
                js: jsCallbackMs,
                candidate: candidateCallbackMs,
            },
            {
                key: "marshal",
                label: "input boundary",
                js: jsPhases.marshalMs,
                candidate: candidatePhases.marshalMs,
            },
            {
                key: "execute",
                label: "execute",
                js: jsPhases.executeMs,
                candidate: candidatePhases.executeMs,
            },
            {
                key: "decode",
                label: "decode",
                js: jsPhases.decodeMs,
                candidate: candidatePhases.decodeMs,
            },
            {
                key: "rewind",
                label: "rewind",
                js: jsPhases.rewindMs,
                candidate: candidatePhases.rewindMs,
            },
            {
                key: "host",
                label: engine === "vir-full" ? "host (nested)" : "DOM apply",
                js: jsPhases.hostMs,
                candidate: candidatePhases.hostMs,
            },
            {
                key: "adapter",
                label: "outer gap",
                js: jsPhases.adapterMs,
                candidate: candidatePhases.adapterMs,
            },
        ];
    }

    /**
     * @param {HTMLElement} target
     * @param {ReturnType<typeof pairedPhaseDefinitions>} definitions
     * @param {"aggregate" | "row"} scope
     */
    function renderPairedPhaseBars(target, definitions, scope) {
        var scale = 0;
        for (var definition of definitions) {
            scale = Math.max(scale, definition.js, definition.candidate);
        }
        scale = Math.max(scale, 0.000001);
        for (var definition of definitions) {
            var group = target.querySelector(
                "[data-" + scope + '-phase-group="' + definition.key + '"]',
            );
            if (!(group instanceof HTMLElement)) continue;
            var label = group.querySelector("[data-" + scope + "-phase-label]");
            if (label) label.textContent = definition.label;
            for (var pair of [
                ["js", definition.js],
                ["candidate", definition.candidate],
            ]) {
                var owner = String(pair[0]);
                var value = Number(pair[1]);
                var output = group.querySelector(
                    "[data-" + scope + '-phase-value="' + owner + '"]',
                );
                var fill = /** @type {HTMLElement | null} */ (
                    group.querySelector("[data-" + scope + '-phase-fill="' + owner + '"]')
                );
                if (output) output.textContent = formatNumber(value, 3);
                if (fill) {
                    fill.style.height =
                        value <= 0 ? "0" : formatNumber((value / scale) * 94, 1) + "px";
                }
            }
        }
    }

    /**
     * @param {PhaseAggregate} jsPhases
     * @param {PhaseAggregate} candidatePhases
     * @param {number} jsCallbackMs
     * @param {number} candidateCallbackMs
     * @param {boolean} enabled
     * @param {"vir-selection" | "vir-full" | "fir"} engine
     */
    function renderAggregatePhases(
        jsPhases,
        candidatePhases,
        jsCallbackMs,
        candidateCallbackMs,
        enabled,
        engine,
    ) {
        var target = /** @type {HTMLElement | null} */ (
            document.querySelector("[data-aggregate-phases]")
        );
        if (!target) return;
        target.hidden = !enabled;
        if (!enabled) return;
        renderPairedPhaseBars(
            target,
            pairedPhaseDefinitions(
                jsPhases,
                candidatePhases,
                jsCallbackMs,
                candidateCallbackMs,
                engine,
            ),
            "aggregate",
        );
        var note = target.querySelector("[data-aggregate-phase-note]");
        if (note) {
            note.textContent =
                engine === "vir-full"
                    ? "Paired bars share one linear millisecond scale. Full VIR host time is nested inside execute; phases are not additive."
                    : "JS and the selection backend time the same renderer, with callback order balanced across examples. DOM differences reflect the rolling frame mix, segment replacements, and timer resolution; phases are not stacked.";
        }
    }

    /**
     * @param {HTMLElement} target
     * @param {PhaseAggregate} jsPhases
     * @param {PhaseAggregate} candidatePhases
     * @param {number} jsCallbackMs
     * @param {number} candidateCallbackMs
     * @param {boolean} enabled
     * @param {"vir-selection" | "vir-full" | "fir"} engine
     */
    function renderRowPhaseComparison(
        target,
        jsPhases,
        candidatePhases,
        jsCallbackMs,
        candidateCallbackMs,
        enabled,
        engine,
    ) {
        target.hidden = !enabled;
        if (!enabled) return;
        renderPairedPhaseBars(
            target,
            pairedPhaseDefinitions(
                jsPhases,
                candidatePhases,
                jsCallbackMs,
                candidateCallbackMs,
                engine,
            ),
            "row",
        );
        var note = target.querySelector("[data-row-phase-note]");
        if (note) {
            note.textContent =
                engine === "vir-full"
                    ? "One scale for this example. Full VIR host time is nested inside execute; phases are not additive."
                    : "Same renderer on both sides; callback order is balanced across examples, while this rolling mean remains sensitive to segment replacements and timer resolution.";
        }
    }

    /**
     * @param {HTMLElement} target
     * @param {ReturnType<typeof phaseSnapshot>} snapshot
     * @param {boolean} enabled
     * @param {"js" | "vir-selection" | "vir-full" | "fir"} engine
     */
    function renderPhaseMetric(target, snapshot, enabled, engine) {
        /** @param {string} name @param {number} value */
        function setPhase(name, value) {
            var node = target.querySelector("[data-phase=" + name + "]");
            if (node) node.textContent = formatNumber(value, 3) + " ms";
        }
        setPhase("marshal", snapshot.marshalMs);
        setPhase("execute", snapshot.executeMs);
        setPhase("decode", snapshot.decodeMs);
        setPhase("rewind", snapshot.rewindMs);
        setPhase("host", snapshot.hostMs);
        setPhase("total", snapshot.totalMs);
        setPhase("adapter", snapshot.adapterMs);
        var scratch = target.querySelector("[data-phase=scratch]");
        if (scratch) scratch.textContent = formatBytes(snapshot.scratchBytes);
        var title = target.querySelector("[data-phase-title]");
        if (title) {
            title.textContent =
                engine === "js"
                    ? "JavaScript selection callback"
                    : engine === "fir"
                      ? "FIR selection callback"
                      : engine === "vir-selection"
                        ? "VIR selection callback"
                        : "VIR full callback";
        }
        var inputLabel = target.querySelector("[data-phase-label=input]");
        if (inputLabel) {
            inputLabel.textContent =
                engine === "js"
                    ? "direct JS object"
                    : engine === "fir"
                      ? "event encode"
                      : engine === "vir-selection"
                        ? "event normalize"
                        : "marshal";
        }
        var executeLabel = target.querySelector("[data-phase-label=execute]");
        if (executeLabel) {
            executeLabel.textContent = engine === "js" ? "decision + selection" : "execute";
        }
        var decodeLabel = target.querySelector("[data-phase-label=decode]");
        if (decodeLabel) decodeLabel.textContent = engine === "js" ? "no decode" : "decode";
        var hostLabel = target.querySelector("[data-phase-label=host]");
        if (hostLabel) {
            hostLabel.textContent =
                engine === "js" || engine === "fir" || engine === "vir-selection"
                    ? "shared DOM apply"
                    : "host ⊂ execute";
        }
        var count = target.querySelector("[data-phase-count]");
        if (count) {
            count.textContent = enabled
                ? String(snapshot.samples) + " timed callbacks"
                : "timing disabled";
        }
        var setup = target.querySelector("[data-phase-setup]");
        if (setup) {
            var creation = snapshot.creation;
            setup.textContent =
                engine === "js"
                    ? "plain JS object · zero conversion"
                    : engine === "vir-selection" && creation
                      ? "create " +
                        formatNumber(creation.totalMs, 2) +
                        " ms · project " +
                        formatNumber(creation.projectMs, 2) +
                        " ms · marshal " +
                        formatNumber(creation.encodeMs, 2) +
                        " ms · retained Lean handle"
                      : engine === "fir" && creation
                        ? "create " +
                          formatNumber(creation.totalMs, 2) +
                          " ms · project " +
                          formatNumber(creation.projectMs, 2) +
                          " ms · selection encode " +
                          formatNumber(creation.encodeMs, 2) +
                          " ms · resident " +
                          formatBytes(creation.persistentBytes)
                        : "shared runtime";
        }
    }

    /** @param {string} engine */
    function metricMarkup(engine) {
        return (
            '<div class="metric" data-engine="' +
            engine +
            '">' +
            '<span><strong data-stat="fps">0.0</strong><small>callback FPS</small></span>' +
            '<span><strong data-stat="cpu">0.0%</strong><small>main-thread CPU</small></span>' +
            '<span><strong data-stat="mean">—</strong><small>rolling mean</small></span>' +
            '<span><strong data-stat="p95">—</strong><small>rolling p95</small></span>' +
            '<span><strong data-stat="max">—</strong><small>run peak callback</small></span>' +
            '<span><strong data-stat="long">0</strong><small>slow callbacks total</small></span>' +
            "</div>"
        );
    }

    /** @param {"js" | "candidate"} owner */
    function phaseMarkup(owner) {
        return (
            '<div class="phase-metric" hidden data-' +
            owner +
            "-phases>" +
            "<header><strong data-phase-title>VIR retained callback</strong><span><small data-phase-count>0 retained callbacks</small><small data-phase-setup>shared runtime</small></span></header>" +
            '<span><strong data-phase="marshal">0.000 ms</strong><small data-phase-label="input">marshal</small></span>' +
            '<span><strong data-phase="execute">0.000 ms</strong><small data-phase-label="execute">execute</small></span>' +
            '<span><strong data-phase="decode">0.000 ms</strong><small data-phase-label="decode">decode</small></span>' +
            '<span><strong data-phase="rewind">0.000 ms</strong><small>rewind</small></span>' +
            '<span><strong data-phase="host">0.000 ms</strong><small data-phase-label="host">host ⊂ execute</small></span>' +
            '<span><strong data-phase="total">0.000 ms</strong><small>candidate total</small></span>' +
            '<span><strong data-phase="adapter">0.000 ms</strong><small>outer gap</small></span>' +
            '<span><strong data-phase="scratch">0 B</strong><small>scratch</small></span>' +
            "</div>"
        );
    }

    /** @param {string} key @param {string} label */
    function rowPhaseGroupMarkup(key, label) {
        return (
            '<div class="aggregate-phase-group" data-row-phase-group="' +
            key +
            '"><div class="aggregate-phase-bars"><span class="aggregate-phase-column js"><output data-row-phase-value="js">0.000</output><i data-row-phase-fill="js"></i></span><span class="aggregate-phase-column candidate" data-row-phase-candidate-column><output data-row-phase-value="candidate">0.000</output><i data-row-phase-fill="candidate"></i></span></div><span class="aggregate-phase-label" data-row-phase-label>' +
            label +
            "</span></div>"
        );
    }

    function rowPhaseComparisonMarkup() {
        return (
            '<section class="row-phase-comparison" data-row-phase-comparison hidden>' +
            '<div class="aggregate-phase-head"><div><strong>Paired detailed callback phases</strong><p data-row-phase-note>One scale for this example; paired bars are rolling means and phases are not stacked.</p></div><div class="aggregate-phase-legend"><span><i class="js"></i>JavaScript</span><span><i class="candidate" data-row-candidate-legend></i><span data-candidate-name>Lean · VIR selection</span></span></div></div>' +
            '<div class="aggregate-phase-chart">' +
            rowPhaseGroupMarkup("callback", "whole callback") +
            rowPhaseGroupMarkup("marshal", "input boundary") +
            rowPhaseGroupMarkup("execute", "execute") +
            rowPhaseGroupMarkup("decode", "decode") +
            rowPhaseGroupMarkup("rewind", "rewind") +
            rowPhaseGroupMarkup("host", "DOM apply") +
            rowPhaseGroupMarkup("adapter", "outer gap") +
            "</div></section>"
        );
    }

    var status = document.getElementById("comparison-status");
    var grid = document.getElementById("comparison-grid");
    if (!(status instanceof HTMLElement) || !(grid instanceof HTMLElement)) {
        throw new Error("comparison dashboard shell is incomplete");
    }
    var dashboardStatus = status;
    var dashboardGrid = grid;

    try {
        examples.forEach(function (example, index) {
            var article = document.createElement("article");
            article.className = "example";
            article.dataset.example = String(index);
            article.innerHTML =
                '<header><div><span class="number">' +
                String(index + 1).padStart(2, "0") +
                "</span><h2></h2></div>" +
                '<div class="row-status"><span>' +
                String(example.data.fps) +
                " source FPS</span><span data-row-state>paused</span><span data-dom-match>DOM match</span></div></header>" +
                '<div class="pair">' +
                '<section class="player"><h3><span class="engine-dot js"></span>JavaScript</h3>' +
                '<div class="stage" data-stage="js"></div>' +
                metricMarkup("js") +
                phaseMarkup("js") +
                "</section>" +
                '<section class="player"><h3><span class="engine-dot vir" data-candidate-dot></span><span data-candidate-name>Lean · VIR</span></h3>' +
                '<div class="stage" data-stage="candidate"></div>' +
                metricMarkup("candidate") +
                '<div class="overhead-ratio" data-overhead-ratio data-overhead-state="waiting"><div><strong data-overhead-value>—</strong><small>whole callback / paired JavaScript</small></div><output data-overhead-detail>waiting for paired callbacks</output><span class="overhead-track"><i data-overhead-fill></i><b title="JavaScript baseline"></b></span></div>' +
                phaseMarkup("candidate") +
                "</section></div>" +
                rowPhaseComparisonMarkup() +
                '<footer><button type="button" data-action="advance">Play / pause / advance</button>' +
                '<button type="button" class="quiet" data-action="reset">Reset</button>' +
                '<input type="range" min="0" value="0" aria-label="Shared animation frame">' +
                "<output data-frame>0 / " +
                String(example.data.totalFrames - 1) +
                "</output></footer>";
            var heading = article.querySelector("h2");
            if (heading) heading.textContent = example.title;
            dashboardGrid.appendChild(article);
        });

        var runtimeModule = await import(runtimeUrl);
        if (typeof runtimeModule.createVirRuntime !== "function") {
            throw new Error("VIR runtime module does not export createVirRuntime");
        }
        var runtime = /** @type {ComparisonVirRuntime} */ (
            await runtimeModule.createVirRuntime({
                wasmUrl: wasmUrl,
                irPackageSetUrl: packageSetUrl,
            })
        );

        /** @returns {Promise<ComparisonFirAdapter | null>} */
        async function loadFirAdapter() {
            try {
                var module = await import(new URL(firAdapterUrl, window.location.href).href);
                if (
                    module.ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION !==
                        "fir.illuminate-player.browser/v4" ||
                    module.ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION !==
                        "lean-4.32-Illuminate.Animation.SelectionAnimation/v4" ||
                    module.ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION !==
                        "fir.illuminate-player.persistent-checkpoint/v2" ||
                    module.ILLUMINATE_SELECTION_PLAYER_HOT_EVENT_VERSION !==
                        "fir.illuminate-player.hot-event/v1" ||
                    typeof module.fetchIlluminateSelectionPlayerAdapter !== "function"
                ) {
                    throw new Error("staged FIR live package has an unsupported contract");
                }
                var loaded = /** @type {ComparisonFirAdapter} */ (
                    await module.fetchIlluminateSelectionPlayerAdapter(
                        new URL(firWasmUrl, window.location.href),
                        {
                            descriptorUrl: new URL(firManifestUrl, window.location.href),
                            buildUrl: new URL(firBuildUrl, window.location.href),
                        },
                    )
                );
                if (typeof loaded.dispatchTick !== "function") {
                    throw new Error("staged FIR live package does not expose scalar tick dispatch");
                }
                return loaded;
            } catch (error) {
                console.info("FIR live comparison backend is unavailable", error);
                return null;
            }
        }

        var firAdapter = await loadFirAdapter();
        var backendSelect = /** @type {HTMLSelectElement} */ (
            document.getElementById("comparison-backend")
        );
        var firOption = /** @type {HTMLOptionElement} */ (
            backendSelect.querySelector('option[value="fir"]')
        );
        if (firAdapter !== null) {
            firOption.disabled = false;
            firOption.textContent = "Lean · FIR";
        } else {
            firOption.title = "Stage an accepted persistent package under test_output/fir-live";
        }
        var virTiming = /** @type {HTMLInputElement} */ (
            document.getElementById("comparison-vir-timing")
        );
        var viewSelect = /** @type {HTMLSelectElement} */ (
            document.getElementById("comparison-view")
        );
        var scopeSelect = /** @type {HTMLSelectElement} */ (
            document.getElementById("comparison-scope")
        );
        /** @type {"vir-selection" | "vir-full" | "fir"} */
        var currentBackend =
            labParams.get("backend") === "fir" && firAdapter !== null
                ? "fir"
                : labParams.get("backend") === "vir-full"
                  ? "vir-full"
                  : "vir-selection";
        backendSelect.value = currentBackend;
        viewSelect.value = currentView;
        scopeSelect.value = currentScope;
        virTiming.checked = labParams.get("detail") === "1";
        phaseTiming = virTiming;
        function updateVirTiming() {
            var showDetailedCharts = detailedChartsEnabled();
            runtime.setCallbackTimingObserver(
                virTiming.checked && currentBackend === "vir-full" ? recordVirCallbackTiming : null,
            );
            virTiming.setAttribute("aria-expanded", String(showDetailedCharts));
            for (var panel of document.querySelectorAll(".phase-metric")) {
                if (panel instanceof HTMLElement) panel.hidden = true;
            }
            for (var comparison of document.querySelectorAll("[data-row-phase-comparison]")) {
                if (comparison instanceof HTMLElement) comparison.hidden = !showDetailedCharts;
            }
            var aggregatePhases = /** @type {HTMLElement | null} */ (
                document.querySelector("[data-aggregate-phases]")
            );
            if (aggregatePhases) aggregatePhases.hidden = !showDetailedCharts;
        }
        function handleVirTimingChange() {
            updateVirTiming();
            syncLabUrl();
        }
        virTiming.addEventListener("change", handleVirTimingChange);

        /** @param {AnimData} data @param {number} index @returns {ComparisonCandidate} */
        function mountVirFullCandidate(data, index) {
            var mounted = /** @type {{ kind?: string, value?: unknown }} */ (
                runtime.call(
                    "Illuminate.Animation.Vir.mountAnimation",
                    JSON.stringify(data),
                    '[data-example="' + String(index) + '"] [data-stage="candidate"]',
                )
            );
            if (mounted.kind !== "ok") throw new Error(String(mounted.value));
            var handle = mounted.value;
            return {
                advance: function () {
                    runtime.call("Illuminate.Animation.Vir.advancePlayer", handle);
                },
                pause: function () {
                    runtime.call("Illuminate.Animation.Vir.pausePlayer", handle);
                },
                seek: function (frame) {
                    runtime.call("Illuminate.Animation.Vir.seekPlayer", handle, frame);
                },
                dispose: function () {
                    runtime.call("Illuminate.Animation.Vir.disposePlayer", handle);
                },
            };
        }

        /** @param {AnimData} data @param {HTMLElement} container @returns {ComparisonCandidate} */
        function mountVirSelectionIn(data, container) {
            var renderer = createSelectionDomRenderer(data, container);
            return createVirSelectionPlayerHost(
                runtime,
                data,
                renderer,
                undefined,
                recordVirSelectionObservation,
                function () {
                    return Boolean(phaseTiming?.checked);
                },
            );
        }

        /** @param {AnimData} data @param {HTMLElement} container @returns {ComparisonCandidate} */
        function mountFirIn(data, container) {
            if (firAdapter === null) throw new Error("FIR live backend is unavailable");
            var renderer = createSelectionDomRenderer(data, container);
            return createFirLivePlayerHost(
                firAdapter,
                data,
                renderer,
                undefined,
                recordFirObservation,
                function () {
                    return Boolean(phaseTiming?.checked);
                },
            );
        }

        /** @param {AnimData} data @param {number} index @returns {ComparisonCandidate} */
        function mountVirSelectionCandidate(data, index) {
            var container = document.querySelector(
                '[data-example="' + String(index) + '"] [data-stage="candidate"]',
            );
            if (!(container instanceof HTMLElement)) {
                throw new Error("VIR selection candidate container is missing");
            }
            return mountVirSelectionIn(data, container);
        }

        /** @param {AnimData} data @param {number} index @returns {ComparisonCandidate} */
        function mountFirCandidate(data, index) {
            var container = document.querySelector(
                '[data-example="' + String(index) + '"] [data-stage="candidate"]',
            );
            if (!(container instanceof HTMLElement)) {
                throw new Error("FIR candidate container is missing");
            }
            return mountFirIn(data, container);
        }

        updateVirTiming();

        /** @param {AnimData} data @param {number} index @returns {ComparisonCandidate} */
        function mountCandidate(data, index) {
            if (currentBackend === "fir") return mountFirCandidate(data, index);
            if (currentBackend === "vir-full") return mountVirFullCandidate(data, index);
            return mountVirSelectionCandidate(data, index);
        }

        /** @type {ComparisonRow[]} */
        var rows = [];

        examples.forEach(function (example, index) {
            var article = /** @type {HTMLElement} */ (
                dashboardGrid.querySelector('[data-example="' + String(index) + '"]')
            );
            var jsStage = /** @type {HTMLElement} */ (article.querySelector('[data-stage="js"]'));
            var jsOwner = "js-" + String(index);
            var candidateOwner = currentBackend + "-" + String(index);
            registerMetrics(jsOwner, "js");
            registerMetrics(candidateOwner, currentBackend === "fir" ? "fir" : "vir");
            var legacy = withOwner(jsOwner, function () {
                return mountLegacy(example.data, jsStage, recordJsSelectionTiming, function () {
                    return Boolean(phaseTiming?.checked);
                });
            });
            var candidate = withOwner(candidateOwner, function () {
                return mountCandidate(example.data, index);
            });
            rows.push({
                index: index,
                data: example.data,
                legacy: legacy,
                candidate: candidate,
                jsOwner: jsOwner,
                candidateOwner: candidateOwner,
                candidateFirst: index % 2 === 1,
                waitingSince: null,
                loopSince: null,
                finishedSince: null,
            });
        });

        function updateCandidatePresentation() {
            var name =
                currentBackend === "fir"
                    ? "Lean · FIR selection"
                    : currentBackend === "vir-full"
                      ? "Lean · VIR full"
                      : "Lean · VIR selection";
            for (var label of document.querySelectorAll("[data-candidate-name]")) {
                label.textContent = name;
            }
            var stickyName = document.querySelector("[data-sticky-candidate-name]");
            if (stickyName) {
                stickyName.textContent =
                    currentBackend === "fir"
                        ? "FIR"
                        : currentBackend === "vir-full"
                          ? "VIR full"
                          : "VIR selection";
            }
            for (var dot of document.querySelectorAll("[data-candidate-dot]")) {
                dot.classList.toggle("vir", currentBackend !== "fir");
                dot.classList.toggle("fir", currentBackend === "fir");
            }
            var summary = document.querySelector('[data-summary="candidate"]');
            var summaryName = summary?.querySelector("h2");
            if (summaryName) summaryName.textContent = name + " aggregate";
            var summaryDot = summary?.querySelector(".engine-dot");
            summaryDot?.classList.toggle("vir", currentBackend !== "fir");
            summaryDot?.classList.toggle("fir", currentBackend === "fir");
            for (var candidateVisual of document.querySelectorAll(
                '[data-aggregate-cpu-fill="candidate"], [data-aggregate-candidate-legend], [data-aggregate-phase-candidate-column], [data-row-candidate-legend], [data-row-phase-candidate-column]',
            )) {
                candidateVisual.classList.toggle("fir", currentBackend === "fir");
            }
        }

        /** @param {"vir-selection" | "vir-full" | "fir"} backend */
        function switchBackend(backend) {
            if (backend === currentBackend) return;
            if (backend === "fir" && firAdapter === null) {
                backendSelect.value = currentBackend;
                return;
            }
            rows.forEach(function (row) {
                withOwner(row.jsOwner, row.legacy.pause);
            });
            var snapshots = rows.map(function (row) {
                return row.legacy.snapshot();
            });
            rows.forEach(function (row) {
                withOwner(row.candidateOwner, row.candidate.dispose);
                metrics.delete(row.candidateOwner);
                registerMetrics(row.jsOwner, "js");
                var article = dashboardGrid.querySelector(
                    '[data-example="' + String(row.index) + '"]',
                );
                article?.querySelector('[data-stage="candidate"]')?.replaceChildren();
            });
            currentBackend = backend;
            updateVirTiming();
            rows.forEach(function (row, index) {
                row.candidateOwner = currentBackend + "-" + String(row.index);
                registerMetrics(row.candidateOwner, currentBackend === "fir" ? "fir" : "vir");
                row.candidate = withOwner(row.candidateOwner, function () {
                    return mountCandidate(row.data, row.index);
                });
                withOwner(row.candidateOwner, function () {
                    row.candidate.seek(snapshots[index].frame);
                });
                row.waitingSince = null;
                row.loopSince = null;
                row.finishedSince = null;
                row.candidateFirst = row.index % 2 === 1;
            });
            updateCandidatePresentation();
        }

        backendSelect.addEventListener("change", function () {
            var backend = backendSelect.value;
            switchBackend(
                backend === "fir" ? "fir" : backend === "vir-full" ? "vir-full" : "vir-selection",
            );
            updateLabStatus();
            syncLabUrl();
        });
        updateCandidatePresentation();

        var fixtureSelect = /** @type {HTMLSelectElement} */ (
            document.getElementById("fixture-select")
        );
        var fixtureScrub = /** @type {HTMLInputElement} */ (
            document.getElementById("fixture-scrub")
        );
        var fixtureFrame = document.getElementById("fixture-frame");
        var fixtureParity = document.querySelector("[data-fixture-parity]");
        /** @type {Array<{ id: string, player: LegacyPlayer | ComparisonCandidate }>} */
        var fixturePlayers = [];
        /** @type {number | null} */
        var fixtureWaitingSince = null;
        /** @type {number | null} */
        var fixtureLoopSince = null;
        /** @type {number | null} */
        var fixtureFinishedSince = null;

        examples.forEach(function (example, index) {
            var option = document.createElement("option");
            option.value = String(index);
            option.textContent = String(index + 1).padStart(2, "0") + " · " + example.title;
            fixtureSelect.appendChild(option);
        });
        var requestedFixture = labParams.get("fixture");
        if (requestedFixture !== null) {
            var requestedKey = requestedFixture;
            var requestedIndex = Number.parseInt(requestedFixture, 10);
            if (!Number.isSafeInteger(requestedIndex)) {
                requestedIndex = examples.findIndex(function (example) {
                    return example.title.toLowerCase() === requestedKey.toLowerCase();
                });
            }
            if (requestedIndex >= 0 && requestedIndex < examples.length) {
                fixtureSelect.value = String(requestedIndex);
            }
        }

        function syncLabUrl() {
            var url = new URL(window.location.href);
            url.searchParams.set("fixture", fixtureSelect.value);
            url.searchParams.set("view", currentView);
            url.searchParams.set("scope", currentScope);
            url.searchParams.set("backend", currentBackend);
            if (virTiming.checked) {
                url.searchParams.set("detail", "1");
            } else {
                url.searchParams.delete("detail");
            }
            window.history.replaceState(null, "", url);
        }

        /** @param {string} id */
        function fixtureCard(id) {
            return /** @type {HTMLElement} */ (
                document.querySelector('[data-fixture-backend="' + id + '"]')
            );
        }

        /** @param {string} id */
        function fixtureStage(id) {
            return /** @type {HTMLElement} */ (
                document.querySelector('[data-fixture-stage="' + id + '"]')
            );
        }

        /** @param {string} id @param {"ready" | "unavailable" | "error"} state @param {string} message */
        function setFixtureState(id, state, message) {
            var card = fixtureCard(id);
            card.dataset.state = state;
            var output = card.querySelector("[data-fixture-state]");
            if (output) output.textContent = message;
        }

        function disposeFixturePlayers() {
            fixturePlayers.reverse().forEach(function (entry) {
                entry.player.dispose();
            });
            fixturePlayers = [];
        }

        /** @param {string} id @param {() => LegacyPlayer | ComparisonCandidate} mount */
        function mountFixturePlayer(id, mount) {
            try {
                var player = mount();
                fixturePlayers.push({ id: id, player: player });
                setFixtureState(id, "ready", "ready");
            } catch (error) {
                setFixtureState(
                    id,
                    "error",
                    error instanceof Error ? error.message : String(error),
                );
            }
        }

        function resetFixtureTimers() {
            fixtureWaitingSince = null;
            fixtureLoopSince = null;
            fixtureFinishedSince = null;
        }

        function mountFocusedFixture() {
            disposeFixturePlayers();
            resetFixtureTimers();
            var index = Number(fixtureSelect.value);
            var example = examples[index];
            if (!example) throw new Error("focused animation fixture is missing");
            for (var id of ["js", "vir", "fir"]) fixtureStage(id).replaceChildren();
            mountFixturePlayer("js", function () {
                return mountLegacy(example.data, fixtureStage("js"));
            });
            mountFixturePlayer("vir", function () {
                return mountVirSelectionIn(example.data, fixtureStage("vir"));
            });
            if (firAdapter === null) {
                fixtureStage("fir").textContent = "Stage the accepted FIR selection package.";
                setFixtureState("fir", "unavailable", "package not staged");
            } else {
                mountFixturePlayer("fir", function () {
                    return mountFirIn(example.data, fixtureStage("fir"));
                });
            }
            fixtureScrub.max = String(example.data.totalFrames - 1);
            fixtureScrub.value = "0";
            if (fixtureFrame) {
                fixtureFrame.textContent = "0 / " + String(example.data.totalFrames - 1);
            }
            if (fixtureParity) {
                fixtureParity.textContent =
                    String(fixturePlayers.length) + "/4 backends ready · checking DOM parity";
                fixtureParity.classList.remove("mismatch");
            }
            syncLabUrl();
        }

        function advanceFocusedFixture() {
            fixturePlayers.forEach(function (entry) {
                entry.player.advance();
            });
        }

        function pauseFocusedFixture() {
            fixturePlayers.forEach(function (entry) {
                entry.player.pause();
            });
        }

        /** @param {number} frame */
        function seekFocusedFixture(frame) {
            fixturePlayers.forEach(function (entry) {
                entry.player.seek(frame);
            });
            resetFixtureTimers();
        }

        function focusedFixtureSnapshot() {
            var jsEntry = fixturePlayers.find(function (entry) {
                return entry.id === "js";
            });
            return jsEntry && "snapshot" in jsEntry.player
                ? /** @type {LegacyPlayer} */ (jsEntry.player).snapshot()
                : null;
        }

        /** @param {number} currentTime */
        function refreshFocusedFixture(currentTime) {
            var snapshot = focusedFixtureSnapshot();
            if (snapshot === null) return;
            fixtureScrub.value = String(snapshot.frame);
            var example = examples[Number(fixtureSelect.value)];
            if (fixtureFrame && example) {
                fixtureFrame.textContent =
                    String(snapshot.frame) + " / " + String(example.data.totalFrames - 1);
            }
            var jsSvg = fixtureStage("js").firstElementChild;
            var compared = fixturePlayers.filter(function (entry) {
                return entry.id !== "js";
            });
            var matches = false;
            if (jsSvg !== null) {
                var baselineSvg = jsSvg;
                matches = compared.every(function (entry) {
                    var candidateSvg = fixtureStage(entry.id).firstElementChild;
                    return candidateSvg !== null && baselineSvg.isEqualNode(candidateSvg);
                });
            }
            if (fixtureParity) {
                fixtureParity.textContent = matches
                    ? String(fixturePlayers.length) + "/4 ready · DOM match"
                    : String(fixturePlayers.length) + "/4 ready · between frames";
                fixtureParity.classList.toggle("mismatch", !matches);
            }
            var autoCycle = /** @type {HTMLInputElement} */ (
                document.getElementById("comparison-auto-cycle")
            );
            if (currentView !== "playback" || !autoCycle.checked) return;
            if (snapshot.playback === "waiting") {
                fixtureWaitingSince = fixtureWaitingSince ?? currentTime;
                if (currentTime - fixtureWaitingSince > 700) {
                    advanceFocusedFixture();
                    fixtureWaitingSince = null;
                }
            } else {
                fixtureWaitingSince = null;
            }
            var step = example?.data.steps[snapshot.step];
            if (
                snapshot.playback === "looping" &&
                step &&
                snapshot.step + 1 < example.data.steps.length
            ) {
                fixtureLoopSince = fixtureLoopSince ?? currentTime;
                if (currentTime - fixtureLoopSince > 1500) {
                    advanceFocusedFixture();
                    fixtureLoopSince = null;
                }
            } else {
                fixtureLoopSince = null;
            }
            if (snapshot.playback === "finished") {
                fixtureFinishedSince = fixtureFinishedSince ?? currentTime;
                if (currentTime - fixtureFinishedSince > 700) {
                    seekFocusedFixture(0);
                    advanceFocusedFixture();
                    fixtureFinishedSince = null;
                }
            } else {
                fixtureFinishedSince = null;
            }
        }

        fixtureSelect.addEventListener("change", function () {
            mountFocusedFixture();
            if (currentView === "playback") {
                advanceFocusedFixture();
            } else if (currentScope === "selected") {
                rows.forEach(pauseRow);
                updateAnalysisVisibility();
                activeAnalysisRows().forEach(advanceRow);
            }
            updateLabStatus();
        });
        document
            .getElementById("fixture-advance")
            ?.addEventListener("click", advanceFocusedFixture);
        document.getElementById("fixture-pause")?.addEventListener("click", pauseFocusedFixture);
        fixtureScrub.addEventListener("input", function () {
            seekFocusedFixture(Number(fixtureScrub.value));
        });
        mountFocusedFixture();

        /** @param {ComparisonRow} row */
        function advanceRow(row) {
            // requestAnimationFrame preserves registration order closely enough that the
            // second renderer can benefit from warm browser and JavaScript state. Balance
            // that order across rows and reverse it whenever a row is scheduled again.
            if (row.candidateFirst) {
                withOwner(row.candidateOwner, row.candidate.advance);
                withOwner(row.jsOwner, row.legacy.advance);
            } else {
                withOwner(row.jsOwner, row.legacy.advance);
                withOwner(row.candidateOwner, row.candidate.advance);
            }
            row.candidateFirst = !row.candidateFirst;
        }

        /** @param {ComparisonRow} row */
        function pauseRow(row) {
            withOwner(row.jsOwner, row.legacy.pause);
            withOwner(row.candidateOwner, row.candidate.pause);
        }

        /** @param {ComparisonRow} row @param {number} frame */
        function seekRow(row, frame) {
            withOwner(row.jsOwner, function () {
                row.legacy.seek(frame);
            });
            withOwner(row.candidateOwner, function () {
                row.candidate.seek(frame);
            });
        }

        function selectedFixtureIndex() {
            return Number(fixtureSelect.value);
        }

        /** @returns {ComparisonRow[]} */
        function activeAnalysisRows() {
            if (currentScope === "all") return rows;
            var selected = selectedFixtureIndex();
            return rows.filter(function (row) {
                return row.index === selected;
            });
        }

        /** @param {ComparisonRow} row */
        function analysisIncludes(row) {
            return currentScope === "all" || row.index === selectedFixtureIndex();
        }

        function updateAnalysisVisibility() {
            rows.forEach(function (row) {
                var article = /** @type {HTMLElement | null} */ (
                    dashboardGrid.querySelector('[data-example="' + String(row.index) + '"]')
                );
                if (article) article.hidden = !analysisIncludes(row);
            });
        }

        function updateLabStatus() {
            if (currentView === "playback") {
                dashboardStatus.textContent =
                    String(examples.length) +
                    " fixtures · " +
                    String(fixturePlayers.length) +
                    "/4 playback backends · LLVM package pending";
            } else if (currentScope === "all") {
                dashboardStatus.textContent =
                    String(rows.length) +
                    " fixtures · " +
                    String(rows.length * 2) +
                    " analyzer players · " +
                    backendSelect.selectedOptions[0].textContent;
            } else {
                dashboardStatus.textContent =
                    examples[selectedFixtureIndex()].title +
                    " · 2 analyzer players · " +
                    backendSelect.selectedOptions[0].textContent;
            }
        }

        /** @param {"playback" | "analysis"} nextView @param {boolean} start */
        function applyLabView(nextView, start) {
            rows.forEach(pauseRow);
            pauseFocusedFixture();
            currentView = nextView;
            viewSelect.value = currentView;
            for (var panel of document.querySelectorAll("[data-lab-panel]")) {
                if (panel instanceof HTMLElement) {
                    panel.hidden = panel.dataset.labPanel !== currentView;
                }
            }
            for (var control of document.querySelectorAll("[data-analysis-control]")) {
                if (control instanceof HTMLElement) control.hidden = currentView !== "analysis";
            }
            updateAnalysisVisibility();
            if (start) {
                if (currentView === "playback") {
                    advanceFocusedFixture();
                } else {
                    activeAnalysisRows().forEach(advanceRow);
                }
            }
            updateLabStatus();
            syncLabUrl();
        }

        /** @param {"selected" | "all"} nextScope */
        function applyAnalysisScope(nextScope) {
            rows.forEach(pauseRow);
            currentScope = nextScope;
            scopeSelect.value = currentScope;
            updateAnalysisVisibility();
            if (currentView === "analysis") activeAnalysisRows().forEach(advanceRow);
            updateLabStatus();
            syncLabUrl();
        }

        rows.forEach(function (row) {
            var article = /** @type {HTMLElement} */ (
                dashboardGrid.querySelector('[data-example="' + String(row.index) + '"]')
            );
            var advance = article.querySelector('[data-action="advance"]');
            var reset = article.querySelector('[data-action="reset"]');
            var scrubber = /** @type {HTMLInputElement} */ (
                article.querySelector('input[type="range"]')
            );
            scrubber.max = String(row.data.totalFrames - 1);
            advance?.addEventListener("click", function () {
                advanceRow(row);
            });
            reset?.addEventListener("click", function () {
                seekRow(row, 0);
            });
            scrubber.addEventListener("input", function () {
                seekRow(row, Number(scrubber.value));
            });
        });

        var autoCycle = /** @type {HTMLInputElement} */ (
            document.getElementById("comparison-auto-cycle")
        );
        viewSelect.addEventListener("change", function () {
            applyLabView(viewSelect.value === "analysis" ? "analysis" : "playback", true);
        });
        scopeSelect.addEventListener("change", function () {
            applyAnalysisScope(scopeSelect.value === "all" ? "all" : "selected");
        });
        document.getElementById("comparison-start")?.addEventListener("click", function () {
            activeAnalysisRows().forEach(advanceRow);
        });
        document.getElementById("comparison-pause")?.addEventListener("click", function () {
            autoCycle.checked = false;
            activeAnalysisRows().forEach(pauseRow);
        });
        document.getElementById("comparison-reset")?.addEventListener("click", function () {
            activeAnalysisRows().forEach(function (row) {
                seekRow(row, 0);
            });
        });
        document.getElementById("comparison-clear-peaks")?.addEventListener("click", function () {
            activeAnalysisRows().forEach(function (row) {
                var jsValue = metrics.get(row.jsOwner);
                var candidateValue = metrics.get(row.candidateOwner);
                if (jsValue) clearPersistentMetrics(jsValue);
                if (candidateValue) clearPersistentMetrics(candidateValue);
            });
            refreshDashboard();
        });

        function refreshDashboard() {
            var now = performance.now();
            refreshFocusedFixture(now);
            /** @type {{ js: DashboardEngineTotals, candidate: DashboardEngineTotals }} */
            var engineTotals = {
                js: {
                    fps: 0,
                    cpu: 0,
                    mean: 0,
                    active: 0,
                    phases: emptyPhaseAggregate(),
                    maximum: 0,
                    maximumAt: null,
                    maximumCallback: null,
                    slowCallbacks: 0,
                    peakTitle: "—",
                },
                candidate: {
                    fps: 0,
                    cpu: 0,
                    mean: 0,
                    active: 0,
                    phases: emptyPhaseAggregate(),
                    maximum: 0,
                    maximumAt: null,
                    maximumCallback: null,
                    slowCallbacks: 0,
                    peakTitle: "—",
                },
            };
            rows.forEach(function (row) {
                var article = dashboardGrid.querySelector(
                    '[data-example="' + String(row.index) + '"]',
                );
                if (!(article instanceof HTMLElement)) return;
                var jsValue = metrics.get(row.jsOwner);
                var candidateValue = metrics.get(row.candidateOwner);
                if (!jsValue || !candidateValue) return;
                var jsMetric = metricSnapshot(jsValue, now);
                var candidateMetric = metricSnapshot(candidateValue, now);
                var jsPhases = phaseSnapshot(jsValue, jsMetric.mean, now);
                var candidatePhases = phaseSnapshot(candidateValue, candidateMetric.mean, now);
                var included = currentView === "analysis" && analysisIncludes(row);
                if (included) {
                    addPhaseAggregate(engineTotals.js.phases, jsPhases);
                    addPhaseAggregate(engineTotals.candidate.phases, candidatePhases);
                }
                renderMetric(
                    /** @type {HTMLElement} */ (article.querySelector('[data-engine="js"]')),
                    jsMetric,
                );
                renderMetric(
                    /** @type {HTMLElement} */ (article.querySelector('[data-engine="candidate"]')),
                    candidateMetric,
                );
                renderOverheadRatio(
                    /** @type {HTMLElement} */ (article.querySelector("[data-overhead-ratio]")),
                    jsMetric,
                    candidateMetric,
                );
                renderPhaseMetric(
                    /** @type {HTMLElement} */ (article.querySelector("[data-js-phases]")),
                    jsPhases,
                    virTiming.checked,
                    "js",
                );
                renderPhaseMetric(
                    /** @type {HTMLElement} */ (article.querySelector("[data-candidate-phases]")),
                    candidatePhases,
                    virTiming.checked,
                    currentBackend,
                );
                renderRowPhaseComparison(
                    /** @type {HTMLElement} */ (
                        article.querySelector("[data-row-phase-comparison]")
                    ),
                    jsPhases,
                    candidatePhases,
                    jsMetric.mean,
                    candidateMetric.mean,
                    detailedChartsEnabled(),
                    currentBackend,
                );
                if (included) {
                    for (var pair of [
                        ["js", jsMetric],
                        ["candidate", candidateMetric],
                    ]) {
                        var engine = /** @type {"js" | "candidate"} */ (pair[0]);
                        var value = /** @type {ReturnType<typeof metricSnapshot>} */ (pair[1]);
                        engineTotals[engine].fps += value.fps;
                        engineTotals[engine].cpu += value.cpuPercent;
                        if (value.fps > 0) {
                            engineTotals[engine].mean += value.mean;
                            engineTotals[engine].active += 1;
                        }
                        engineTotals[engine].slowCallbacks += value.longFrames;
                        if (value.maximum > engineTotals[engine].maximum) {
                            engineTotals[engine].maximum = value.maximum;
                            engineTotals[engine].maximumAt = value.maximumAt;
                            engineTotals[engine].maximumCallback = value.maximumCallback;
                            engineTotals[engine].peakTitle = examples[row.index].title;
                        }
                    }
                }
                var snapshot = row.legacy.snapshot();
                var scrubber = /** @type {HTMLInputElement} */ (
                    article.querySelector('input[type="range"]')
                );
                scrubber.value = String(snapshot.frame);
                var frameOutput = article.querySelector("[data-frame]");
                if (frameOutput) {
                    frameOutput.textContent =
                        String(snapshot.frame) + " / " + String(row.data.totalFrames - 1);
                }
                var rowState = article.querySelector("[data-row-state]");
                if (rowState) rowState.textContent = snapshot.playback;
                var jsStage = article.querySelector('[data-stage="js"]');
                var candidateStage = article.querySelector('[data-stage="candidate"]');
                var match = Boolean(
                    jsStage &&
                    candidateStage &&
                    jsStage.firstElementChild &&
                    candidateStage.firstElementChild &&
                    jsStage.firstElementChild.isEqualNode(candidateStage.firstElementChild),
                );
                var domMatch = article.querySelector("[data-dom-match]");
                if (domMatch) {
                    domMatch.textContent = match ? "DOM match" : "between frames";
                    domMatch.classList.toggle("mismatch", !match);
                }

                if (autoCycle.checked && included) {
                    if (snapshot.playback === "waiting") {
                        row.waitingSince = row.waitingSince ?? now;
                        if (now - row.waitingSince > 700) {
                            advanceRow(row);
                            row.waitingSince = null;
                        }
                    } else {
                        row.waitingSince = null;
                    }
                    var step = row.data.steps[snapshot.step];
                    if (
                        snapshot.playback === "looping" &&
                        step &&
                        snapshot.step + 1 < row.data.steps.length
                    ) {
                        row.loopSince = row.loopSince ?? now;
                        if (now - row.loopSince > 1500) {
                            advanceRow(row);
                            row.loopSince = null;
                        }
                    } else {
                        row.loopSince = null;
                    }
                    if (snapshot.playback === "finished") {
                        row.finishedSince = row.finishedSince ?? now;
                        if (now - row.finishedSince > 700) {
                            seekRow(row, 0);
                            advanceRow(row);
                            row.finishedSince = null;
                        }
                    } else {
                        row.finishedSince = null;
                    }
                }
            });
            for (var engine of /** @type {Array<"js" | "candidate">} */ (["js", "candidate"])) {
                var values = engineTotals[engine];
                var fps = values.active === 0 ? 0 : values.fps / values.active;
                var summary = document.querySelector('[data-summary="' + engine + '"]');
                if (summary) {
                    var summaryFps = summary.querySelector("[data-summary-stat=fps]");
                    var summaryCpu = summary.querySelector("[data-summary-stat=cpu]");
                    var summaryPeak = summary.querySelector("[data-summary-stat=peak]");
                    if (summaryFps) summaryFps.textContent = formatNumber(fps, 1);
                    if (summaryCpu) {
                        summaryCpu.textContent = formatNumber(values.cpu, 1) + "%";
                    }
                    if (summaryPeak) summaryPeak.textContent = formatDuration(values.maximum);
                }
            }
            var jsMean =
                engineTotals.js.active === 0 ? 0 : engineTotals.js.mean / engineTotals.js.active;
            var candidateMean =
                engineTotals.candidate.active === 0
                    ? 0
                    : engineTotals.candidate.mean / engineTotals.candidate.active;
            var summaryRatio = document.querySelector(
                '[data-summary="candidate"] [data-summary-stat="ratio"]',
            );
            if (summaryRatio) {
                summaryRatio.textContent =
                    jsMean > 0 ? formatNumber(candidateMean / jsMean, 2) + "×" : "—";
            }
            var aggregateOverhead = /** @type {HTMLElement | null} */ (
                document.querySelector("[data-aggregate-overhead]")
            );
            if (aggregateOverhead) {
                renderOverheadRatio(aggregateOverhead, { mean: jsMean }, { mean: candidateMean });
            }
            renderAggregateCpu(engineTotals.js.cpu, engineTotals.candidate.cpu);
            renderPersistentPeaks(
                {
                    maximum: engineTotals.js.maximum,
                    maximumAt: engineTotals.js.maximumAt,
                    maximumCallback: engineTotals.js.maximumCallback,
                    slowCallbacks: engineTotals.js.slowCallbacks,
                    title: engineTotals.js.peakTitle,
                },
                {
                    maximum: engineTotals.candidate.maximum,
                    maximumAt: engineTotals.candidate.maximumAt,
                    maximumCallback: engineTotals.candidate.maximumCallback,
                    slowCallbacks: engineTotals.candidate.slowCallbacks,
                    title: engineTotals.candidate.peakTitle,
                },
                now,
            );
            renderAggregatePhases(
                averagePhaseAggregate(engineTotals.js.phases),
                averagePhaseAggregate(engineTotals.candidate.phases),
                jsMean,
                candidateMean,
                detailedChartsEnabled(),
                currentBackend,
            );
        }

        window.__illuminateComparisonSnapshot = function () {
            var now = performance.now();
            return {
                view: currentView,
                scope: currentScope,
                fixture: selectedFixtureIndex(),
                backend: currentBackend,
                firAvailable: firAdapter !== null,
                timingEnabled: virTiming.checked,
                rows: rows.map(function (row) {
                    var jsValue = metrics.get(row.jsOwner);
                    var candidate = metrics.get(row.candidateOwner);
                    var callback = candidate ? metricSnapshot(candidate, now) : null;
                    return {
                        index: row.index,
                        title: examples[row.index].title,
                        jsCallback: jsValue ? metricSnapshot(jsValue, now) : null,
                        jsPhases: jsValue
                            ? phaseSnapshot(jsValue, metricSnapshot(jsValue, now).mean, now)
                            : null,
                        callback: callback,
                        phases: candidate
                            ? phaseSnapshot(candidate, callback?.mean ?? 0, now)
                            : null,
                    };
                }),
            };
        };

        window.__illuminateComparisonResetMetrics = function () {
            rows.forEach(function (row) {
                var jsValue = metrics.get(row.jsOwner);
                var candidateValue = metrics.get(row.candidateOwner);
                if (jsValue) clearRunMetrics(jsValue);
                if (candidateValue) clearRunMetrics(candidateValue);
            });
            refreshDashboard();
        };

        status.dataset.state = "ready";
        document.body.dataset.ready = "true";
        applyLabView(currentView, true);
        var refreshTimer = setInterval(refreshDashboard, 250);

        window.addEventListener(
            "pagehide",
            function () {
                clearInterval(refreshTimer);
                virTiming.removeEventListener("change", handleVirTimingChange);
                runtime.setCallbackTimingObserver(null);
                disposeFixturePlayers();
                rows.forEach(function (row) {
                    row.legacy.dispose();
                    row.candidate.dispose();
                });
                runtime.dispose();
                delete window.__illuminateComparisonSnapshot;
                delete window.__illuminateComparisonResetMetrics;
                window.requestAnimationFrame = nativeRequestAnimationFrame;
                window.cancelAnimationFrame = nativeCancelAnimationFrame;
            },
            { once: true },
        );
    } catch (error) {
        var message = error instanceof Error ? error.message : String(error);
        status.textContent = "Comparison failed: " + message;
        status.dataset.state = "error";
        console.error("Illuminate comparison dashboard failed", error);
    }
})();
