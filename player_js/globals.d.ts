// Type declarations for template placeholders and external APIs used by player JS.

interface StepInfo {
    frame: number;
    pause: boolean;
    loop: boolean;
}
interface ParamBinding {
    e: number;
    a: string;
}
interface Segment {
    sf: number;
    fc: number;
    sync: string;
    pmap: ParamBinding[];
    params: string[][];
    /** Runtime cache of indexed SVG elements, populated by the widget player. */
    _elems?: Element[];
}
interface AnimData {
    fps: number;
    totalFrames: number;
    segments: Segment[];
    steps: StepInfo[];
}

interface FirComparisonAdapter {
    createPlayer(animation: AnimData): unknown;
    dispatch(player: unknown, event: unknown): unknown;
    dispatchTick(player: unknown, timestamp: number): unknown;
    disposePlayer(player: unknown): void;
    replayTrace(animation: AnimData, events: unknown[]): unknown;
}

interface FirComparisonRenderer {
    render(action: unknown): void;
    dispose?(): void;
}

declare function createSelectionDomRenderer(
    animation: AnimData,
    container: HTMLElement,
): FirComparisonRenderer;
declare function createFirLivePlayerHost(
    adapter: FirComparisonAdapter,
    animation: AnimData,
    renderer: FirComparisonRenderer,
    scheduler?: {
        request(callback: FrameRequestCallback): number;
        cancel(handle: number): void;
    },
    observer?: ((observation: any) => void) | null,
    observeDispatch?: (() => boolean) | null,
): {
    advance(): void;
    pause(): void;
    seek(frame: number): void;
    dispose(): void;
};
declare function createSelectionPlayerHost(
    adapter: FirComparisonAdapter,
    animation: AnimData,
    renderer: FirComparisonRenderer,
    scheduler?: {
        request(callback: FrameRequestCallback): number;
        cancel(handle: number): void;
    },
    observer?: ((observation: any) => void) | null,
    observeDispatch?: (() => boolean) | null,
): {
    advance(): void;
    pause(): void;
    seek(frame: number): void;
    dispose(): void;
};
declare function loadLlvmSelectionPlayerAdapter(assets: {
    adapterUrl: URL;
    manifestUrl: URL;
}): Promise<FirComparisonAdapter>;
declare function createVirSelectionPlayerHost(
    runtime: {
        call(name: string, ...args: unknown[]): unknown;
        callTimed(
            name: string,
            ...args: unknown[]
        ): { value: unknown; timings: Record<string, number> };
    },
    animation: AnimData,
    renderer: FirComparisonRenderer,
    scheduler?: {
        request(callback: FrameRequestCallback): number;
        cancel(handle: number): void;
    },
    observer?: ((observation: any) => void) | null,
    observeDispatch?: (() => boolean) | null,
): {
    advance(): void;
    pause(): void;
    seek(frame: number): void;
    dispose(): void;
};

interface Window {
    __illuminateComparisonSnapshot?: () => unknown;
    __illuminateComparisonResetMetrics?: () => void;
}

// standalone.js and reveal.js use these placeholders that are
// string-replaced before the JS is embedded in HTML.
declare var __ILLUMINATE_DATA_98712__: AnimData;
declare var __ILLUMINATE_SELECTOR_98712__: string;
declare var __ILLUMINATE_COMPARISON_DATA_98712__: Array<{
    title: string;
    data: AnimData;
}>;
declare var __ILLUMINATE_COMPARISON_RUNTIME_98712__: string;
declare var __ILLUMINATE_COMPARISON_WASM_98712__: string;
declare var __ILLUMINATE_COMPARISON_PACKAGE_SET_98712__: string;
declare var __ILLUMINATE_VIR_RUNTIME_98712__: string;
declare var __ILLUMINATE_VIR_WASM_98712__: string;
declare var __ILLUMINATE_VIR_PACKAGE_SET_98712__: string;

// reveal.js uses the Reveal.js API when available (3.x and 4.x)
declare var Reveal: {
    addEventListener?(type: string, fn: Function): void;
    removeEventListener?(type: string, fn: Function): void;
    on?(type: string, fn: Function): void;
    off?(type: string, fn: Function): void;
};
