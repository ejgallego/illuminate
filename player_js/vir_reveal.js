// @ts-check

/**
 * @typedef {{
 *   call(name: string, ...args: unknown[]): unknown,
 *   dispose(): void
 * }} IlluminateVirRuntime
 * @typedef {{
 *   runtime: IlluminateVirRuntime | null,
 *   promise: Promise<IlluminateVirRuntime>,
 *   players: Map<unknown, { selector: string, fragments: HTMLElement[], dispose: () => void }>
 * }} IlluminateVirRevealService
 * @typedef {Window & {
 *   __illuminateVirRevealServices?: Map<string, IlluminateVirRevealService>,
 *   __illuminateVirRevealNextId?: number
 * }} IlluminateVirRevealWindow
 * @typedef {{ fragment: HTMLElement }} IlluminateRevealFragmentEvent
 * @typedef {{ previousSlide?: HTMLElement, currentSlide?: HTMLElement }} IlluminateRevealSlideEvent
 */

(async function () {
    /** @type {AnimData} */
    var data = __ILLUMINATE_DATA_98712__;
    var selector = "__ILLUMINATE_SELECTOR_98712__";
    var runtimeUrl = "__ILLUMINATE_VIR_RUNTIME_98712__";
    var wasmUrl = "__ILLUMINATE_VIR_WASM_98712__";
    var packageSetUrl = "__ILLUMINATE_VIR_PACKAGE_SET_98712__";
    var root = /** @type {IlluminateVirRevealWindow} */ (window);
    var services = root.__illuminateVirRevealServices;
    if (!services) {
        services = new Map();
        root.__illuminateVirRevealServices = services;
    }
    var serviceKey = JSON.stringify([runtimeUrl, wasmUrl, packageSetUrl]);
    var service = services.get(serviceKey);
    if (!service) {
        /** @type {IlluminateVirRevealService} */
        var created = {
            runtime: null,
            promise: import(runtimeUrl).then(function (module) {
                if (typeof module.createVirRuntime !== "function") {
                    throw new Error("VIR runtime module does not export createVirRuntime");
                }
                return module.createVirRuntime({
                    wasmUrl: wasmUrl,
                    irPackageSetUrl: packageSetUrl,
                });
            }),
            players: new Map(),
        };
        created.promise = created.promise.then(function (runtime) {
            created.runtime = runtime;
            return runtime;
        });
        service = created;
        services.set(serviceKey, service);
        window.addEventListener(
            "pagehide",
            function () {
                created.promise
                    .then(function (runtime) {
                        Array.from(created.players.values()).forEach(function (player) {
                            player.dispose();
                        });
                        created.players.clear();
                        runtime.dispose();
                    })
                    .catch(function (error) {
                        console.error("Illuminate VIR Reveal cleanup failed", error);
                    });
            },
            { once: true },
        );
    }

    try {
        var activeService = service;
        var runtime = await activeService.promise;
        var mounted = /** @type {{ kind?: string, value?: unknown }} */ (
            runtime.call("Illuminate.Animation.Vir.mountAnimation", JSON.stringify(data), selector)
        );
        if (mounted.kind !== "ok") {
            throw new Error(String(mounted.value || "VIR Reveal mount failed"));
        }
        var handle = mounted.value;
        var container = document.querySelector(selector);
        if (!(container instanceof HTMLElement)) {
            throw new Error("Reveal animation container not found: " + selector);
        }
        var count = Number(runtime.call("Illuminate.Animation.Vir.revealFragmentCount", handle));
        /** @type {HTMLElement[]} */
        var fragments = [];
        var parent = container.parentElement;
        var owner = root.__illuminateVirRevealNextId || 0;
        root.__illuminateVirRevealNextId = owner + 1;
        for (var index = 0; index < count; index += 1) {
            var fragment = document.createElement("span");
            fragment.className = "fragment";
            fragment.dataset.fragmentIndex = String(index);
            fragment.dataset.illuminateVirOwner = String(owner);
            fragment.style.display = "none";
            if (parent) parent.appendChild(fragment);
            fragments.push(fragment);
        }

        var disposed = false;
        /** @type {(type: string, callback: Function) => void} */
        var revealOn = function () {};
        /** @type {((type: string, callback: Function) => void) | null} */
        var revealOff = null;
        /** @type {(event: IlluminateRevealFragmentEvent) => void} */
        var shown = function (event) {
            var index = fragments.indexOf(event.fragment);
            if (!disposed && index >= 0) {
                runtime.call("Illuminate.Animation.Vir.fragmentShown", handle, index);
            }
        };
        /** @type {(event: IlluminateRevealFragmentEvent) => void} */
        var hidden = function (event) {
            var index = fragments.indexOf(event.fragment);
            if (!disposed && index >= 0) {
                runtime.call("Illuminate.Animation.Vir.fragmentHidden", handle, index);
            }
        };
        /** @type {(event: IlluminateRevealSlideEvent) => void} */
        var slideChanged = function (event) {
            if (!disposed && event.previousSlide && event.previousSlide.contains(container)) {
                runtime.call("Illuminate.Animation.Vir.pausePlayer", handle);
            }
        };
        if (typeof Reveal !== "undefined") {
            if (typeof Reveal.on === "function") {
                revealOn = Reveal.on.bind(Reveal);
            } else if (typeof Reveal.addEventListener === "function") {
                revealOn = Reveal.addEventListener.bind(Reveal);
            }
            if (typeof Reveal.off === "function") {
                revealOff = Reveal.off.bind(Reveal);
            } else if (typeof Reveal.removeEventListener === "function") {
                revealOff = Reveal.removeEventListener.bind(Reveal);
            }
            revealOn("fragmentshown", shown);
            revealOn("fragmenthidden", hidden);
            revealOn("slidechanged", slideChanged);
        }

        var dispose = function () {
            if (disposed) return;
            disposed = true;
            if (revealOff) {
                revealOff("fragmentshown", shown);
                revealOff("fragmenthidden", hidden);
                revealOff("slidechanged", slideChanged);
            }
            fragments.forEach(function (fragment) {
                fragment.remove();
            });
            runtime.call("Illuminate.Animation.Vir.disposePlayer", handle);
            activeService.players.delete(handle);
        };
        activeService.players.set(handle, {
            selector: selector,
            fragments: fragments,
            dispose: dispose,
        });
    } catch (error) {
        console.error("Illuminate VIR Reveal player failed", error);
    }
})();
