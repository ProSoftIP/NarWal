// Synchronized replay in the browser. One clock (session ms) drives the page,
// the narration audio, the transcript and the markers:
//
// - Paused or seeking: the page is rebuilt at exactly the session time
//   (rrweb `pause(offset)`), and the audio is set to the fitted media time.
// - Playing: rrweb and the audio element run on their own and are corrected
//   only when they drift more than AUDIO_SYNC_TOLERANCE_MS from the clock,
//   so the narration is not chopped by constant small seeks. While the
//   narration is heard moving, the clock follows it, so the audio's own
//   start-up and seek delays are not carried as error.
//
// rrweb is passed in (createReplayer), so this module has no dependency and the
// caller chooses the build. The player refuses a replay frame with any sandbox
// other than `allow-same-origin` (sandbox.ts).

import { CLOCK_BREAK_MS } from './audio-clock.ts';
import { describeGap } from './labels.ts';
import { AUDIO_SYNC_TOLERANCE_MS, stateAt, type Marker, type ReplayModel, type ReplayPage, type ReplayState, type RrwebEvent } from './model.ts';
import { assertSandboxed } from './sandbox.ts';

/** The part of rrweb's Replayer the player uses. */
export interface ReplayerLike {
  wrapper: HTMLElement;
  iframe: HTMLIFrameElement;
  play(timeOffset?: number): void;
  pause(timeOffset?: number): void;
  getCurrentTime(): number;
  destroy(): void;
}

export type ReplayerFactory = (events: RrwebEvent[], root: HTMLElement) => ReplayerLike;

export interface PlayerOptions {
  model: ReplayModel;
  /** Empty element the player fills. */
  stage: HTMLElement;
  /** Element whose source is the bundle's narration; null when there is none. */
  audio: HTMLMediaElement | null;
  createReplayer: ReplayerFactory;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Called after every update with what is shown. */
  onUpdate?: (state: ReplayState) => void;
}

/** After the audio is moved, it gets this long to start before it is checked again. */
const AUDIO_SETTLE_MS = 400;
/** Below CLOCK_BREAK_MS, so the clock never follows the audio across a break in the recording. */
const FOLLOW_MAX_MS = CLOCK_BREAK_MS / 2;
const DEFAULT_VIEWPORT = { w: 1280, h: 800 };

function el(doc: Document, className: string): HTMLDivElement {
  const div = doc.createElement('div');
  div.className = className;
  return div;
}

export class ReplayPlayer {
  readonly model: ReplayModel;
  #o: Required<Omit<PlayerOptions, 'onUpdate' | 'audio'>> & Pick<PlayerOptions, 'onUpdate' | 'audio'>;
  #viewport: HTMLDivElement;
  #pageRoot: HTMLDivElement;
  #overlay: HTMLDivElement;
  #banner: HTMLDivElement;
  #markers: HTMLDivElement;
  #replayer: ReplayerLike | null = null;
  #mounted: ReplayPage | null = null;
  #rrPlaying = false;
  #pausedOffset: number | null = null;
  #playing = false;
  #time = 0;
  #baseTime = 0;
  #baseNow = 0;
  #frame: number | null = null;
  #audioMovedAt = -Infinity;
  /** Audio position at the previous frame, to tell moving audio from starting or stalled audio. */
  #lastAudioSec: number | null = null;
  #state: ReplayState;

  constructor(options: PlayerOptions) {
    const win = options.stage.ownerDocument.defaultView;
    this.#o = {
      now: () => performance.now(),
      requestFrame: (cb) => (win ?? globalThis).requestAnimationFrame(cb),
      cancelFrame: (h) => (win ?? globalThis).cancelAnimationFrame(h),
      ...options,
    };
    this.model = options.model;
    const doc = options.stage.ownerDocument;
    this.#viewport = el(doc, 'narwal-replay-viewport');
    this.#pageRoot = el(doc, 'narwal-replay-page');
    this.#overlay = el(doc, 'narwal-replay-gap');
    this.#banner = el(doc, 'narwal-replay-banner');
    this.#markers = el(doc, 'narwal-replay-markers');
    this.#overlay.setAttribute('role', 'status');
    this.#banner.setAttribute('role', 'status');
    this.#viewport.append(this.#pageRoot, this.#overlay);
    options.stage.replaceChildren(this.#banner, this.#viewport);
    this.#state = stateAt(this.model, 0);
    this.#render(true);
  }

  get time(): number {
    return this.#playing ? this.#clock() : this.#time;
  }

  get playing(): boolean {
    return this.#playing;
  }

  /** What is shown now. */
  state(): ReplayState {
    return this.#state;
  }

  /** The live rrweb frame, for checks; null while no page is shown. */
  get frame(): HTMLIFrameElement | null {
    return this.#replayer?.iframe ?? null;
  }

  play(): void {
    if (this.#playing) return;
    if (this.#time >= this.model.durationMs) this.#time = 0;
    this.#playing = true;
    this.#baseTime = this.#time;
    this.#baseNow = this.#o.now();
    this.#rrPlaying = false;
    this.#audioMovedAt = -Infinity;
    this.#lastAudioSec = null;
    this.#tick();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#time = this.#clock();
    this.#playing = false;
    if (this.#frame !== null) this.#o.cancelFrame(this.#frame);
    this.#frame = null;
    this.#rrPlaying = false;
    this.#pausedOffset = null;
    this.#o.audio?.pause();
    this.#render(true);
  }

  /** Moves to a session time. Keeps playing if it was playing. */
  seek(ms: number): void {
    const t = Math.min(Math.max(ms, 0), this.model.durationMs);
    this.#time = t;
    this.#baseTime = t;
    this.#baseNow = this.#o.now();
    this.#rrPlaying = false;
    this.#pausedOffset = null;
    this.#audioMovedAt = -Infinity;
    this.#lastAudioSec = null;
    this.#render(true);
  }

  destroy(): void {
    if (this.#frame !== null) this.#o.cancelFrame(this.#frame);
    this.#frame = null;
    this.#playing = false;
    this.#o.audio?.pause();
    this.#replayer?.destroy();
    this.#replayer = null;
    this.#mounted = null;
  }

  #clock(): number {
    return Math.min(this.#baseTime + (this.#o.now() - this.#baseNow), this.model.durationMs);
  }

  #tick = (): void => {
    this.#frame = null;
    if (!this.#playing) return;
    this.#followAudio();
    const t = this.#clock();
    this.#time = t;
    if (t >= this.model.durationMs) {
      this.pause();
      return;
    }
    this.#render(false);
    this.#frame = this.#o.requestFrame(this.#tick);
  };

  /**
   * While the narration moves, the clock is where the narration is. A larger
   * difference than FOLLOW_MAX_MS is never followed: it is a jump to another
   * clock run or a stall, and #syncAudio moves the audio instead.
   */
  #followAudio(): void {
    const audio = this.#o.audio;
    const clock = this.model.audio?.clock;
    if (!audio || !clock || audio.paused || audio.seeking) {
      this.#lastAudioSec = null;
      return;
    }
    const sec = audio.currentTime;
    const moving = this.#lastAudioSec !== null && sec > this.#lastAudioSec;
    this.#lastAudioSec = sec;
    if (!moving) return;
    const at = clock.sessionAt(sec);
    if (at === null || Math.abs(at - this.#clock()) > FOLLOW_MAX_MS) return;
    this.#baseTime = Math.min(at, this.model.durationMs);
    this.#baseNow = this.#o.now();
  }

  #mount(page: ReplayPage | null): void {
    if (page === this.#mounted) return;
    this.#replayer?.destroy();
    this.#replayer = null;
    this.#mounted = page;
    this.#rrPlaying = false;
    this.#pausedOffset = null;
    this.#pageRoot.replaceChildren();
    if (!page) return;
    // rrweb needs two events; a page that is only a snapshot gets a no-op one.
    const events = page.events.length > 1 ? page.events : [...page.events, { type: 5, timestamp: page.events[0]!.timestamp, data: { tag: 'narwal-pad', payload: null } }];
    const replayer = this.#o.createReplayer(events, this.#pageRoot);
    try {
      assertSandboxed(replayer.iframe);
    } catch (err) {
      replayer.destroy();
      this.#mounted = null;
      throw err;
    }
    this.#replayer = replayer;
    replayer.wrapper.append(this.#markers);
    this.#fit(page);
  }

  /** Scales the recorded viewport down to the stage width. */
  #fit(page: ReplayPage): void {
    const { w, h } = page.viewport ?? DEFAULT_VIEWPORT;
    const available = this.#viewport.parentElement?.clientWidth ?? 0;
    const scale = available > 0 ? Math.min(1, available / w) : 1;
    Object.assign(this.#pageRoot.style, { width: `${w}px`, height: `${h}px`, transform: `scale(${scale})`, transformOrigin: '0 0' });
    Object.assign(this.#viewport.style, { width: `${w * scale}px`, height: `${h * scale}px` });
  }

  #render(exact: boolean): void {
    const t = this.#time;
    const state = stateAt(this.model, t);
    this.#state = state;

    // Page.
    const page = state.page ? (this.model.pages.get(state.page.docKey) ?? null) : null;
    if (page || exact) this.#mount(page ?? this.#mounted);
    if (state.page && this.#replayer) {
      const offset = state.page.offsetMs;
      if (!this.#playing) {
        // rrweb applies events strictly before the offset; +1 ms includes one recorded at this very instant.
        if (this.#pausedOffset !== offset) this.#replayer.pause(offset + 1);
        this.#pausedOffset = offset;
        this.#rrPlaying = false;
      } else {
        // After its last event rrweb stops; the page then no longer changes.
        const last = this.#mounted ? this.#mounted.lastEventMs - this.#mounted.firstEventMs : offset;
        const target = Math.min(offset, last);
        if (!this.#rrPlaying || Math.abs(this.#replayer.getCurrentTime() - target) > AUDIO_SYNC_TOLERANCE_MS) {
          this.#replayer.play(offset);
          this.#rrPlaying = true;
        }
      }
    } else if (this.#replayer && this.#rrPlaying) {
      this.#replayer.pause();
      this.#rrPlaying = false;
      this.#pausedOffset = null;
    }

    // Gaps: a missing page is covered and labelled; an incomplete one gets a banner.
    const noPage = state.gaps.filter((g) => g.effect === 'no-page');
    const shown = state.page !== null;
    this.#overlay.hidden = shown;
    this.#overlay.textContent = shown ? '' : noPage.length ? noPage.map(describeGap).join('\n') : 'No page was recorded for this time.';
    const notes = state.gaps.filter((g) => g.effect !== 'no-page');
    this.#banner.hidden = notes.length === 0;
    this.#banner.textContent = notes.map(describeGap).join('\n');
    this.#viewport.dataset.gap = shown ? '' : (noPage[0]?.reason ?? 'no-page-evidence');

    this.#drawMarkers(state.markers);
    this.#syncAudio(state, exact);
    this.#o.onUpdate?.(state);
  }

  #drawMarkers(markers: Marker[]): void {
    const doc = this.#markers.ownerDocument;
    const want = markers.map((m) => m.id).join(' ');
    if (this.#markers.dataset.ids === want) return;
    this.#markers.dataset.ids = want;
    this.#markers.replaceChildren(
      ...markers.flatMap((m) => {
        const out: HTMLDivElement[] = [];
        if (m.rect) {
          const box = el(doc, `narwal-marker narwal-marker-${m.kind}`);
          box.dataset.observation = m.id;
          Object.assign(box.style, { left: `${m.rect.x}px`, top: `${m.rect.y}px`, width: `${m.rect.w}px`, height: `${m.rect.h}px` });
          out.push(box);
        }
        if (m.point) {
          const dot = el(doc, `narwal-marker-point narwal-marker-${m.kind}`);
          dot.dataset.observation = m.id;
          Object.assign(dot.style, { left: `${m.point.x}px`, top: `${m.point.y}px` });
          out.push(dot);
        }
        return out;
      }),
    );
  }

  #syncAudio(state: ReplayState, exact: boolean): void {
    const audio = this.#o.audio;
    if (!audio) return;
    if (!state.audio) {
      if (!audio.paused) audio.pause();
      return;
    }
    const target = state.audio.mediaSec;
    const off = Math.abs(audio.currentTime - target) * 1000;
    if (!this.#playing) {
      if (!audio.paused) audio.pause();
      if (off > 1) audio.currentTime = target;
      return;
    }
    const now = this.#o.now();
    if (audio.paused) {
      audio.currentTime = target;
      this.#audioMovedAt = now;
      void audio.play().catch(() => {});
      return;
    }
    if (audio.seeking) return;
    if ((exact || now - this.#audioMovedAt > AUDIO_SETTLE_MS) && off > AUDIO_SYNC_TOLERANCE_MS) {
      audio.currentTime = target;
      this.#audioMovedAt = now;
    }
  }
}
